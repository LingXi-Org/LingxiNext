from __future__ import annotations

import asyncio
import logging
from dataclasses import dataclass, field
from typing import Any
from uuid import uuid4

import chainlit as cl
from lingxigraph import AIMessage, AIMessageChunk, CancellationToken, Command, HumanMessage
from lingxigraph.events import EventKind
from sqlalchemy.ext.asyncio import AsyncSession

from .graph_templates import CompiledRevision, GraphCompiler
from .models import OrchestrationRevision, ThreadBinding

logger = logging.getLogger(__name__)


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

    async def handle(
        self,
        session: AsyncSession,
        binding: ThreadBinding,
        content: str,
        message_id: str,
    ) -> None:
        runtime = self._runtime(binding.thread_id)
        async with runtime.lock:
            compiled = await self.manager.get(session, str(binding.revision_id))
            current: Any = {"messages": [HumanMessage(content, id=message_id)]}
            while True:
                cancellation = CancellationToken()
                runtime.cancellation = cancellation
                assistant: cl.Message | None = None
                streamed = False
                interrupts: tuple[Any, ...] = ()
                steps: dict[str, cl.Step] = {}
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
                                if assistant is None:
                                    assistant = cl.Message(content="")
                                    await assistant.send()
                                await assistant.stream_token(str(message.content))
                                streamed = True
                        elif event.kind is EventKind.NODE_STARTED:
                            key = event.task_id or event.node or event.event_id
                            step = cl.Step(name=event.node or "graph node", type="run")
                            step.input = "running"
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
                                await existing_step.update()
                        elif event.kind is EventKind.INTERRUPT_RAISED:
                            interrupts = tuple(event.data.get("interrupts", ()))
                    if assistant is not None:
                        await assistant.update()
                    if not streamed and not interrupts:
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
                        if messages and isinstance(messages[-1], AIMessage):
                            await cl.Message(content=str(messages[-1].content)).send()
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
