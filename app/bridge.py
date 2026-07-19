from __future__ import annotations

import asyncio
import json
import logging
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any
from uuid import uuid4

import chainlit as cl
from lingxigraph import AIMessage, AIMessageChunk, CancellationToken, Command, HumanMessage
from lingxigraph.events import EventKind
from lingxigraph.integrations import file_object, image_object
from sqlalchemy.ext.asyncio import AsyncSession

from .graph_templates import CompiledRevision, GraphCompiler
from .models import OrchestrationRevision, ThreadBinding

logger = logging.getLogger(__name__)


def _trace_preview(value: Any, limit: int = 2000) -> str:
    """把事件负载压成安全的短文本，供管理端调试查看。"""
    if value is None:
        return ""
    try:
        rendered = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False, default=str)
    except (TypeError, ValueError):
        rendered = str(value)
    return rendered[:limit]


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _collect_follow_ups(values: Any, messages: Any) -> list[str]:
    """Gather Coze follow-up suggestions from graph state and the final message."""
    seen: dict[str, None] = {}
    for suggestion in (values or {}).get("coze_suggestions", ()) or ():
        text = str(suggestion).strip()
        if text:
            seen.setdefault(text, None)
    if messages and isinstance(messages[-1], AIMessage):
        for suggestion in messages[-1].additional_kwargs.get("follow_ups", ()) or ():
            text = str(suggestion).strip()
            if text:
                seen.setdefault(text, None)
    return list(seen)


@dataclass(slots=True)
class ThreadRuntime:
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    cancellation: CancellationToken | None = None


class GraphManager:
    def __init__(self) -> None:
        self._compiler = GraphCompiler()
        self._compiled: dict[str, CompiledRevision] = {}
        self._compile_locks: dict[str, asyncio.Lock] = {}

    async def get(self, session: AsyncSession, revision_id: str) -> CompiledRevision:
        cached = self._compiled.get(revision_id)
        if cached is not None:
            return cached
        lock = self._compile_locks.setdefault(revision_id, asyncio.Lock())
        async with lock:
            cached = self._compiled.get(revision_id)
            if cached is not None:
                return cached
            revision = await session.get(OrchestrationRevision, revision_id)
            if revision is None:
                raise LookupError("published orchestration revision no longer exists")
            compiled = await self._compiler.compile(session, revision)
            self._compiled[revision_id] = compiled
            return compiled

    def cache_size(self) -> int:
        return len(self._compiled)

    async def invalidate(self, revision_id: str | None = None) -> None:
        targets = (
            [self._compiled.pop(revision_id)]
            if revision_id and revision_id in self._compiled
            else list(self._compiled.values())
            if revision_id is None
            else []
        )
        if revision_id is None:
            self._compiled.clear()
        for item in targets:
            await item.close()


class ChainlitGraphBridge:
    def __init__(self, manager: GraphManager) -> None:
        self.manager = manager
        self._threads: dict[str, ThreadRuntime] = {}

    def _runtime(self, thread_id: str) -> ThreadRuntime:
        return self._threads.setdefault(thread_id, ThreadRuntime())

    async def cancel(self, thread_id: str) -> None:
        runtime = self._threads.get(thread_id)
        if runtime and runtime.cancellation:
            runtime.cancellation.cancel()

    async def upload_files(
        self,
        session: AsyncSession,
        binding: ThreadBinding,
        files: list[tuple[str, bytes, str]],
    ) -> tuple[dict[str, Any], ...]:
        """Upload local files to Coze and return object_string items for the message.

        ``files`` is a list of (filename, content, mime_type). Images (``image/*``)
        become image objects; everything else becomes a file object.
        """
        if not files:
            return ()
        compiled = await self.manager.get(session, str(binding.revision_id))
        if not compiled.clients:
            raise LookupError("bound revision has no Coze connection for uploads")
        client = compiled.clients[0]
        objects: list[dict[str, Any]] = []
        for filename, content, mime in files:
            uploaded = await client.upload_file(
                content, filename=filename, content_type=mime or "application/octet-stream"
            )
            file_id = str(uploaded.get("id") or uploaded.get("file_id") or "")
            if not file_id:
                raise RuntimeError(f"Coze upload returned no file id for {filename}")
            objects.append(
                image_object(file_id) if str(mime).startswith("image/") else file_object(file_id)
            )
        return tuple(objects)

    async def _render_follow_ups(self, thread_id: str, follow_ups: list[str]) -> None:
        """Show Coze follow-up questions as clickable suggestion actions."""
        if not follow_ups:
            return
        actions = [
            cl.Action(
                name="coze_follow_up",
                payload={"question": question},
                label=question[:120],
                tooltip=question,
            )
            for question in follow_ups[:5]
        ]
        await cl.Message(content="你可能还想问：", actions=actions).send()

    async def handle(
        self,
        session: AsyncSession,
        binding: ThreadBinding,
        content: str,
        message_id: str,
        objects: tuple[dict[str, Any], ...] = (),
    ) -> None:
        runtime = self._runtime(binding.thread_id)
        async with runtime.lock:
            compiled = await self.manager.get(session, str(binding.revision_id))
            human = HumanMessage(
                content,
                id=message_id,
                additional_kwargs={"objects": list(objects)} if objects else {},
            )
            current: Any = {"messages": [human]}
            while True:
                cancellation = CancellationToken()
                runtime.cancellation = cancellation
                assistant: cl.Message | None = None
                thinking: cl.Step | None = None
                run_started = time.perf_counter()
                first_token_ms: int | None = None
                streamed = False
                interrupts: tuple[Any, ...] = ()
                steps: dict[str, cl.Step] = {}
                follow_ups: list[str] = []
                try:
                    async for event in compiled.graph.astream(
                        current,
                        {
                            "configurable": {
                                "tenant_id": "default",
                                "thread_id": binding.thread_id,
                                "checkpoint_ns": f"revision/{binding.revision_id}",
                            }
                        },
                        context={"username": binding.username},
                        stream_mode="events",
                        subgraphs=True,
                        run_id=str(uuid4()),
                        cancellation=cancellation,
                    ):
                        if event.kind is EventKind.MESSAGE:
                            value = event.data.get("value")
                            message = (
                                value[0] if isinstance(value, (tuple, list)) and value else value
                            )
                            if isinstance(message, AIMessageChunk) and message.content:
                                if message.additional_kwargs.get("reasoning"):
                                    if thinking is None:
                                        thinking = cl.Step(name="思考中", type="llm")
                                        thinking.start = _now_iso()
                                        await thinking.send()
                                    await thinking.stream_token(str(message.content))
                                    streamed = True
                                else:
                                    if assistant is None:
                                        assistant = cl.Message(content="")
                                        await assistant.send()
                                    if first_token_ms is None:
                                        first_token_ms = round(
                                            (time.perf_counter() - run_started) * 1000
                                        )
                                    # 节点级首字时间：标记产生首个可见 token 的节点
                                    step_key = event.task_id or event.node or event.event_id
                                    node_step = steps.get(step_key)
                                    if node_step is not None and "first_token_at" not in (
                                        node_step.metadata or {}
                                    ):
                                        node_step.metadata = {
                                            **(node_step.metadata or {}),
                                            "first_token_at": _now_iso(),
                                        }
                                    await assistant.stream_token(str(message.content))
                                    streamed = True
                        elif event.kind is EventKind.NODE_STARTED:
                            key = event.task_id or event.node or event.event_id
                            step = cl.Step(
                                name=event.node or "graph node",
                                type="run",
                                metadata={
                                    "node": event.node,
                                    "task_id": event.task_id,
                                    "event_id": event.event_id,
                                    "started_at": _now_iso(),
                                },
                            )
                            step.start = _now_iso()
                            step.input = _trace_preview(event.data.get("input")) or "running"
                            await step.send()
                            steps[key] = step
                        elif event.kind in {
                            EventKind.NODE_COMPLETED,
                            EventKind.NODE_FAILED,
                            EventKind.NODE_RETRYING,
                            EventKind.NODE_CACHED,
                        }:
                            key = event.task_id or event.node or event.event_id
                            existing_step = steps.get(key)
                            if existing_step is not None:
                                existing_step.output = event.kind.value
                                existing_step.is_error = event.kind is EventKind.NODE_FAILED
                                existing_step.end = _now_iso()
                                detail = (
                                    event.data.get("error")
                                    or event.data.get("exception")
                                    or event.data.get("detail")
                                )
                                meta = dict(existing_step.metadata or {})
                                meta["finished_at"] = _now_iso()
                                meta["result"] = event.kind.value
                                if detail is not None:
                                    meta["error"] = _trace_preview(detail)
                                if event.data.get("attempt") is not None:
                                    meta["attempt"] = event.data.get("attempt")
                                existing_step.metadata = meta
                                await existing_step.update()
                        elif event.kind is EventKind.INTERRUPT_RAISED:
                            interrupts = tuple(event.data.get("interrupts", ()))
                    if thinking is not None:
                        thinking.end = _now_iso()
                        await thinking.update()
                    if assistant is not None:
                        assistant.metadata = {
                            **(assistant.metadata or {}),
                            "ttft_ms": first_token_ms,
                            "total_ms": round((time.perf_counter() - run_started) * 1000),
                        }
                        await assistant.update()
                    if not interrupts:
                        snapshot = await compiled.graph.aget_state(
                            {
                                "configurable": {
                                    "tenant_id": "default",
                                    "thread_id": binding.thread_id,
                                    "checkpoint_ns": f"revision/{binding.revision_id}",
                                }
                            }
                        )
                        messages = snapshot.values.get("messages", [])
                        if not streamed and messages and isinstance(messages[-1], AIMessage):
                            await cl.Message(content=str(messages[-1].content)).send()
                        follow_ups = _collect_follow_ups(snapshot.values, messages)
                except Exception:
                    logger.exception(
                        "LingxiGraph run failed", extra={"thread_id": binding.thread_id}
                    )
                    await cl.Message(
                        content="编排运行失败，请稍后重试。管理员可在服务日志中查看请求标识。"
                    ).send()
                    return
                finally:
                    if runtime.cancellation is cancellation:
                        runtime.cancellation = None

                if not interrupts:
                    await self._render_follow_ups(binding.thread_id, follow_ups)
                    return
                answers: dict[str, Any] = {}
                for marker in interrupts:
                    if not marker.resumable:
                        await cl.Message(content="当前编排在不可恢复的中断处停止。").send()
                        return
                    value = marker.value
                    prompt = value.get("message") if isinstance(value, dict) else str(value)
                    response = await cl.AskUserMessage(
                        content=str(prompt or "请输入继续运行所需的信息"), timeout=3600
                    ).send()
                    if not response:
                        return
                    answer: Any = response.get("output") if isinstance(response, dict) else response
                    if isinstance(value, dict) and value.get("type") == "coze_workflow_question":
                        answer = {
                            "event_id": value.get("event_id"),
                            "interrupt_type": value.get("interrupt_type"),
                            "resume_data": answer,
                        }
                    answers[str(marker.id)] = answer
                current = Command(
                    resume=answers if len(answers) > 1 else next(iter(answers.values()))
                )


graph_manager = GraphManager()
bridge = ChainlitGraphBridge(graph_manager)
