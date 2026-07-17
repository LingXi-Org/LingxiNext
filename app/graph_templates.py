from __future__ import annotations

import json
import re
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Annotated, Any, TypedDict

from lingxigraph import (
    END,
    START,
    AIMessage,
    AIMessageChunk,
    Command,
    HumanMessage,
    PostgresSaver,
    Runtime,
    Send,
    StateGraph,
    add_messages,
)
from lingxigraph.integrations import AsyncCozeClient, CozeAgentNode, CozeWorkflowNode
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .config import get_settings
from .models import AgentDefinition, OrchestrationRevision
from .schemas import OrchestrationDraft, ValidationIssue, ValidationResult
from .security import token_cipher


def merge_dict(left: Any, right: Any) -> dict[str, Any]:
    return {**dict(left or {}), **dict(right or {})}


class GraphState(TypedDict, total=False):
    messages: Annotated[list[Any], add_messages]
    coze_conversations: Annotated[dict[str, str], merge_dict]
    active_agent: str
    turn: int
    topic: str
    artifact: str
    reviews: Annotated[dict[str, str], merge_dict]
    plan: str
    execution: str
    workflow_output: Any


class GraphContext(TypedDict, total=False):
    username: str


@dataclass(frozen=True, slots=True)
class AgentSpec:
    id: str
    slug: str
    display_name: str
    kind: str
    remote_id: str
    base_url: str
    token: str
    timeout_seconds: int
    max_retries: int


@dataclass(slots=True)
class CompiledRevision:
    revision_id: str
    digest: str
    graph: Any
    clients: tuple[AsyncCozeClient, ...]

    async def close(self) -> None:
        for client in self.clients:
            await client.aclose()


ROLE_RULES: dict[str, dict[str, tuple[int, int]]] = {
    "topic_auction": {"agent": (1, 32)},
    "supervisor": {"supervisor": (1, 1), "specialist": (1, 31)},
    "handoff": {"agent": (2, 32)},
    "parallel_review": {"source": (1, 1), "reviewer": (1, 29), "judge": (1, 1)},
    "plan_execute": {"planner": (1, 1), "executor": (1, 1), "replanner": (1, 1)},
}


def _diagram(draft: OrchestrationDraft) -> str:
    lines = ["flowchart LR"]
    for node in draft.nodes:
        label = f"{node.id}: {node.role}".replace('"', "'")
        lines.append(f'  {safe_id(node.id)}["{label}"]')
    for edge in draft.edges:
        label = f"|{edge.condition}|" if edge.condition else ""
        lines.append(f"  {safe_id(edge.source)} -->{label} {safe_id(edge.target)}")
    return "\n".join(lines)


def safe_id(value: str) -> str:
    return "n_" + re.sub(r"[^A-Za-z0-9_]", "_", value)


def validate_draft(draft: OrchestrationDraft, agents: dict[str, AgentSpec]) -> ValidationResult:
    issues: list[ValidationIssue] = []
    ids = [node.id for node in draft.nodes]
    if len(ids) != len(set(ids)):
        issues.append(
            ValidationIssue(path="nodes", code="duplicate_node", message="节点 ID 必须唯一")
        )

    rules = ROLE_RULES[draft.template]
    for role, (minimum, maximum) in rules.items():
        count = sum(node.role == role for node in draft.nodes)
        if count < minimum or count > maximum:
            issues.append(
                ValidationIssue(
                    path="nodes",
                    code="invalid_role_count",
                    message=f"角色 {role} 需要 {minimum}..{maximum} 个节点，当前为 {count}",
                )
            )
    allowed_roles = set(rules)
    for index, node in enumerate(draft.nodes):
        if node.role not in allowed_roles:
            issues.append(
                ValidationIssue(
                    path=f"nodes.{index}.role",
                    code="invalid_role",
                    message=f"模板 {draft.template} 不允许角色 {node.role}",
                )
            )
        spec = agents.get(str(node.agent_id))
        if spec is None:
            issues.append(
                ValidationIssue(
                    path=f"nodes.{index}.agent_id",
                    code="agent_unavailable",
                    message="智能体不存在、未启用或连接不可用",
                )
            )
        elif spec.kind not in {"coze_chat", "coze_workflow"}:
            issues.append(
                ValidationIssue(
                    path=f"nodes.{index}.agent_id",
                    code="agent_type_invalid",
                    message="智能体类型必须为 Coze Chat 或 Coze Workflow",
                )
            )
        elif spec.kind == "coze_workflow" and not _workflow_allowed(draft.template, node.role):
            issues.append(
                ValidationIssue(
                    path=f"nodes.{index}.agent_id",
                    code="workflow_role_forbidden",
                    message="Coze Workflow 只能作为 topic 终端 Agent 或 plan_execute executor",
                )
            )
        if draft.template == "topic_auction":
            issues.extend(_validate_auction_config(index, node.config))

    known = set(ids)
    roles_by_id = {node.id: node.role for node in draft.nodes}
    seen_edges: set[tuple[str, str, str | None]] = set()
    for index, edge in enumerate(draft.edges):
        if edge.source not in known or edge.target not in known:
            issues.append(
                ValidationIssue(
                    path=f"edges.{index}",
                    code="unknown_endpoint",
                    message="边必须连接当前画布中的节点",
                )
            )
        if edge.source == edge.target:
            issues.append(
                ValidationIssue(path=f"edges.{index}", code="self_loop", message="不允许节点自环")
            )
        if (
            edge.source in roles_by_id
            and edge.target in roles_by_id
            and not _edge_allowed(
                draft.template, roles_by_id[edge.source], roles_by_id[edge.target]
            )
        ):
            issues.append(
                ValidationIssue(
                    path=f"edges.{index}",
                    code="edge_forbidden",
                    message="该模板不允许这两个角色之间的连线",
                )
            )
        if edge.condition is not None:
            issues.append(
                ValidationIssue(
                    path=f"edges.{index}.condition",
                    code="condition_forbidden",
                    message="首版安全模板不接受自定义边条件",
                )
            )
        key = (edge.source, edge.target, edge.condition)
        if key in seen_edges:
            issues.append(
                ValidationIssue(path=f"edges.{index}", code="duplicate_edge", message="边重复")
            )
        seen_edges.add(key)

    edge_pairs = {(edge.source, edge.target) for edge in draft.edges}
    for source, target in _required_edges(draft):
        if (source, target) not in edge_pairs:
            issues.append(
                ValidationIssue(
                    path="edges",
                    code="required_edge_missing",
                    message=f"模板要求连线 {source} -> {target}",
                )
            )

    if draft.template == "handoff" and _has_cycle(known, edge_pairs):
        issues.append(
            ValidationIssue(
                path="edges",
                code="cycle_forbidden",
                message="handoff peer 图不允许循环；运行时仍会额外限制最大跳数",
            )
        )

    try:
        max_turns = int(draft.settings.get("max_turns", 8))
    except (TypeError, ValueError):
        max_turns = 0
    if max_turns < 1 or max_turns > 40:
        issues.append(
            ValidationIssue(
                path="settings.max_turns",
                code="invalid_limit",
                message="max_turns 必须在 1..40 之间",
            )
        )
    if draft.template == "handoff":
        entry = draft.settings.get("entry_node")
        if not entry:
            issues.append(
                ValidationIssue(
                    path="settings.entry_node",
                    code="entry_required",
                    message="handoff 模板必须指定入口节点",
                )
            )
        elif entry not in known:
            issues.append(
                ValidationIssue(
                    path="settings.entry_node",
                    code="entry_unknown",
                    message="handoff 入口必须引用当前画布中的节点",
                )
            )
        else:
            reachable = _reachable_from(str(entry), edge_pairs)
            for node_id in sorted(known - reachable):
                issues.append(
                    ValidationIssue(
                        path="edges",
                        code="unreachable_node",
                        message=f"节点 {node_id} 无法从 handoff 入口到达",
                    )
                )
    return ValidationResult(valid=not issues, issues=issues, diagram=_diagram(draft))


def _workflow_allowed(template: str, role: str) -> bool:
    return (template == "topic_auction" and role == "agent") or (
        template == "plan_execute" and role == "executor"
    )


def _validate_auction_config(index: int, config: dict[str, Any]) -> list[ValidationIssue]:
    issues: list[ValidationIssue] = []
    for field in ("base_bid", "keyword_bonus", "topic_bonus", "difficulty_weight"):
        value = config.get(field)
        if value is None:
            continue
        if (
            isinstance(value, bool)
            or not isinstance(value, (int, float))
            or not -100 <= value <= 100
        ):
            issues.append(
                ValidationIssue(
                    path=f"nodes.{index}.config.{field}",
                    code="invalid_bid_weight",
                    message=f"{field} 必须是 -100..100 之间的数字",
                )
            )
    for field in ("keywords", "topics", "subscriptions", "exclusive_keywords"):
        value = config.get(field)
        if value is None:
            continue
        if (
            not isinstance(value, list)
            or len(value) > 100
            or any(
                not isinstance(item, str) or not item.strip() or len(item) > 128 for item in value
            )
        ):
            issues.append(
                ValidationIssue(
                    path=f"nodes.{index}.config.{field}",
                    code="invalid_topic_terms",
                    message=f"{field} 必须是最多 100 个非空短字符串",
                )
            )
    return issues


def _edge_allowed(template: str, source_role: str, target_role: str) -> bool:
    allowed = {
        "topic_auction": set(),
        "supervisor": {("supervisor", "specialist"), ("specialist", "supervisor")},
        "handoff": {("agent", "agent")},
        "parallel_review": {("source", "reviewer"), ("reviewer", "judge")},
        "plan_execute": {
            ("planner", "executor"),
            ("executor", "replanner"),
            ("replanner", "executor"),
        },
    }
    return (source_role, target_role) in allowed[template]


def _required_edges(draft: OrchestrationDraft) -> set[tuple[str, str]]:
    by_role: dict[str, list[str]] = {}
    for node in draft.nodes:
        by_role.setdefault(node.role, []).append(node.id)
    if draft.template == "supervisor" and by_role.get("supervisor"):
        manager = by_role["supervisor"][0]
        return {
            edge
            for specialist in by_role.get("specialist", [])
            for edge in ((manager, specialist), (specialist, manager))
        }
    if draft.template == "parallel_review" and by_role.get("source") and by_role.get("judge"):
        source, judge = by_role["source"][0], by_role["judge"][0]
        return {
            edge
            for reviewer in by_role.get("reviewer", [])
            for edge in ((source, reviewer), (reviewer, judge))
        }
    if draft.template == "plan_execute" and all(
        by_role.get(role) for role in ("planner", "executor", "replanner")
    ):
        planner, executor, replanner = (
            by_role["planner"][0],
            by_role["executor"][0],
            by_role["replanner"][0],
        )
        return {(planner, executor), (executor, replanner), (replanner, executor)}
    return set()


def _has_cycle(nodes: set[str], edges: set[tuple[str, str]]) -> bool:
    adjacent: dict[str, list[str]] = {node: [] for node in nodes}
    for source, target in edges:
        if source in adjacent and target in adjacent:
            adjacent[source].append(target)
    visiting: set[str] = set()
    visited: set[str] = set()

    def visit(node: str) -> bool:
        if node in visiting:
            return True
        if node in visited:
            return False
        visiting.add(node)
        if any(visit(target) for target in adjacent[node]):
            return True
        visiting.remove(node)
        visited.add(node)
        return False

    return any(visit(node) for node in nodes if node not in visited)


def _reachable_from(entry: str, edges: set[tuple[str, str]]) -> set[str]:
    adjacent: dict[str, set[str]] = {}
    for source, target in edges:
        adjacent.setdefault(source, set()).add(target)
    pending = [entry]
    reached: set[str] = set()
    while pending:
        current = pending.pop()
        if current in reached:
            continue
        reached.add(current)
        pending.extend(adjacent.get(current, ()))
    return reached


def parse_control(content: str) -> dict[str, Any] | None:
    candidates = [content.strip()]
    fenced = re.findall(r"```(?:json|lingxi-control)?\s*(\{.*?\})\s*```", content, re.S)
    candidates.extend(reversed(fenced))
    candidates.extend(reversed(re.findall(r"\{[^{}]{1,2000}\}", content, re.S)))
    for candidate in candidates:
        try:
            parsed = json.loads(candidate)
        except (json.JSONDecodeError, TypeError):
            continue
        if isinstance(parsed, dict):
            return parsed
    return None


class GraphCompiler:
    def __init__(self) -> None:
        self._saver = PostgresSaver(get_settings().lingxigraph_postgres_url)

    async def load_agent_specs(
        self, session: AsyncSession, draft: OrchestrationDraft
    ) -> dict[str, AgentSpec]:
        requested = {node.agent_id for node in draft.nodes}
        if not requested:
            return {}
        rows = (
            (
                await session.scalars(
                    select(AgentDefinition).where(
                        AgentDefinition.id.in_(requested), AgentDefinition.enabled.is_(True)
                    )
                )
            )
            .unique()
            .all()
        )
        result: dict[str, AgentSpec] = {}
        for item in rows:
            if not item.connection.enabled:
                continue
            expires_at = item.connection.token_expires_at
            if expires_at is not None:
                if expires_at.tzinfo is None:
                    expires_at = expires_at.replace(tzinfo=timezone.utc)
                if expires_at <= datetime.now(timezone.utc):
                    continue
            result[str(item.id)] = AgentSpec(
                id=str(item.id),
                slug=item.slug,
                display_name=item.display_name,
                kind=item.kind,
                remote_id=item.remote_id,
                base_url=item.connection.base_url,
                token=token_cipher().decrypt(item.connection.token_ciphertext),
                timeout_seconds=item.timeout_seconds,
                max_retries=item.max_retries,
            )
        return result

    async def compile(
        self, session: AsyncSession, revision: OrchestrationRevision
    ) -> CompiledRevision:
        draft = OrchestrationDraft.model_validate(revision.config)
        specs = await self.load_agent_specs(session, draft)
        validation = validate_draft(draft, specs)
        if not validation.valid:
            raise ValueError("; ".join(issue.message for issue in validation.issues))

        clients_by_key: dict[tuple[str, str], AsyncCozeClient] = {}

        def client_for(spec: AgentSpec) -> AsyncCozeClient:
            key = (spec.base_url, spec.token)
            if key not in clients_by_key:
                clients_by_key[key] = AsyncCozeClient(
                    spec.token,
                    base_url=spec.base_url,
                    timeout=float(spec.timeout_seconds),
                    max_retries=spec.max_retries,
                )
            return clients_by_key[key]

        nodes = {node.id: (node, specs[str(node.agent_id)]) for node in draft.nodes}
        builder = self._build(draft, nodes, client_for)
        graph = builder.compile(checkpointer=self._saver)
        return CompiledRevision(
            revision_id=str(revision.id),
            digest=revision.digest,
            graph=graph,
            clients=tuple(clients_by_key.values()),
        )

    def _build(self, draft, nodes, client_for):
        if draft.template == "topic_auction":
            return self._topic_auction(draft, nodes, client_for)
        if draft.template == "supervisor":
            return self._supervisor(draft, nodes, client_for)
        if draft.template == "handoff":
            return self._handoff(draft, nodes, client_for)
        if draft.template == "parallel_review":
            return self._parallel_review(draft, nodes, client_for)
        return self._plan_execute(draft, nodes, client_for)

    @staticmethod
    def _chat_node(spec: AgentSpec, client: AsyncCozeClient, *, stream: bool = True):
        async def call(state: GraphState, runtime: Runtime[GraphContext]):
            node = CozeAgentNode(
                spec.remote_id,
                client,
                user_id=str((runtime.context or {}).get("username", "anonymous")),
                stream=stream,
            )
            return await node(state, runtime)

        return call

    @staticmethod
    def _workflow_node(spec: AgentSpec, client: AsyncCozeClient):
        async def call(state: GraphState, runtime: Runtime[GraphContext]):
            def parameters(values):
                latest = values.get("messages", [])[-1] if values.get("messages") else None
                return {
                    "input": str(getattr(latest, "content", "")),
                    "username": str((runtime.context or {}).get("username", "anonymous")),
                }

            output = await CozeWorkflowNode(
                spec.remote_id, client, parameters=parameters, output_key="workflow_output"
            )(state, runtime)
            rendered = json.dumps(output.get("workflow_output"), ensure_ascii=False, default=str)
            runtime.emit_message(AIMessageChunk(rendered), {"provider": "coze_workflow"})
            return {**output, "messages": [AIMessage(rendered)]}

        return call

    def _agent_node(self, spec, client, *, stream=True):
        return (
            self._workflow_node(spec, client)
            if spec.kind == "coze_workflow"
            else self._chat_node(spec, client, stream=stream)
        )

    def _topic_auction(self, draft, nodes, client_for):
        graph = StateGraph(GraphState, context_schema=GraphContext, name="topic-auction")
        for node_id, (_node, spec) in nodes.items():
            graph.add_node(node_id, self._agent_node(spec, client_for(spec)))
            graph.add_edge(node_id, END)

        def route(state: GraphState):
            latest = state.get("messages", [])[-1] if state.get("messages") else None
            text = str(getattr(latest, "content", "")).lower()
            difficulty = min(
                1.0,
                len(text) / 600
                + 0.15 * sum(term in text for term in ("为什么", "分析", "比较", "设计", "debug")),
            )
            scored: list[tuple[int, float, int, str, str]] = []
            last = state.get("active_agent")
            for order, (node_id, (node, _spec)) in enumerate(nodes.items()):
                config = node.config
                score = float(config.get("base_bid", 0.5))
                matched_keywords = [
                    str(keyword)
                    for keyword in config.get("keywords", [])
                    if str(keyword).lower() in text
                ]
                for _keyword in matched_keywords:
                    score += float(config.get("keyword_bonus", 0.25))
                topics = config.get("topics") or config.get("subscriptions") or []
                matched_topics = [str(topic) for topic in topics if str(topic).lower() in text]
                score += len(matched_topics) * float(config.get("topic_bonus", 0.2))
                score += difficulty * float(config.get("difficulty_weight", 0.0))
                if last == node_id:
                    score += float(draft.settings.get("continuity_bonus", 0.1))
                exclusive_terms = config.get("exclusive_keywords", [])
                exclusive = int(any(str(term).lower() in text for term in exclusive_terms))
                topic = (
                    matched_topics[0]
                    if matched_topics
                    else matched_keywords[0]
                    if matched_keywords
                    else "general"
                )
                scored.append((exclusive, score, -order, node_id, topic))
            _exclusive, _score, _order, winner, topic = max(scored)
            return Command(update={"active_agent": winner, "topic": topic}, goto=winner)

        graph.add_node("router", route, destinations=tuple(nodes))
        graph.add_edge(START, "router")
        return graph

    def _supervisor(self, draft, nodes, client_for):
        graph = StateGraph(GraphState, context_schema=GraphContext, name="supervisor")
        supervisor_id = next(
            node_id for node_id, (node, _) in nodes.items() if node.role == "supervisor"
        )
        specialists = [node_id for node_id, (node, _) in nodes.items() if node.role == "specialist"]
        node, spec = nodes[supervisor_id]
        graph.add_node(supervisor_id, self._agent_node(spec, client_for(spec), stream=False))
        max_turns = int(draft.settings.get("max_turns", 8))

        def decide(state: GraphState):
            turn = int(state.get("turn", 0))
            latest = state.get("messages", [])[-1] if state.get("messages") else None
            parsed = parse_control(str(getattr(latest, "content", ""))) or {}
            target = str(parsed.get("next_agent", ""))
            if turn >= max_turns or target == "__end__":
                return Command(goto=END)
            if target not in specialists:
                target = specialists[0] if turn == 0 else END
            return Command(update={"turn": turn + 1, "active_agent": str(target)}, goto=target)

        graph.add_node("supervisor_decision", decide, destinations=(*specialists, END))
        graph.add_edge(START, supervisor_id).add_edge(supervisor_id, "supervisor_decision")
        for specialist in specialists:
            _, specialist_spec = nodes[specialist]
            graph.add_node(
                specialist, self._agent_node(specialist_spec, client_for(specialist_spec))
            )
            graph.add_edge(specialist, supervisor_id)
        return graph

    def _handoff(self, draft, nodes, client_for):
        graph = StateGraph(GraphState, context_schema=GraphContext, name="handoff")
        allowed: dict[str, set[str]] = {node_id: set() for node_id in nodes}
        for edge in draft.edges:
            allowed.setdefault(edge.source, set()).add(edge.target)
        max_turns = int(draft.settings.get("max_turns", 8))

        for node_id, (_node, spec) in nodes.items():
            graph.add_node(node_id, self._agent_node(spec, client_for(spec)))

            def make_decider(current: str):
                def decide(state: GraphState):
                    turn = int(state.get("turn", 0)) + 1
                    latest = state.get("messages", [])[-1] if state.get("messages") else None
                    parsed = parse_control(str(getattr(latest, "content", ""))) or {}
                    target = str(parsed.get("next_agent", "__end__"))
                    if turn >= max_turns or target == "__end__" or target not in allowed[current]:
                        return Command(update={"turn": turn}, goto=END)
                    return Command(update={"turn": turn, "active_agent": target}, goto=target)

                return decide

            decider = f"route_{node_id}"
            graph.add_node(decider, make_decider(node_id), destinations=(*nodes, END))
            graph.add_edge(node_id, decider)
        graph.add_edge(START, str(draft.settings["entry_node"]))
        return graph

    def _parallel_review(self, draft, nodes, client_for):
        graph = StateGraph(GraphState, context_schema=GraphContext, name="parallel-review")
        source = next(node_id for node_id, (node, _) in nodes.items() if node.role == "source")
        reviewers = [node_id for node_id, (node, _) in nodes.items() if node.role == "reviewer"]
        judge = next(node_id for node_id, (node, _) in nodes.items() if node.role == "judge")

        async def source_node(state, runtime):
            _, spec = nodes[source]
            result = await self._chat_node(spec, client_for(spec), stream=False)(state, runtime)
            message = result["messages"][-1]
            return {**result, "artifact": str(message.content)}

        graph.add_node(source, source_node)

        for reviewer in reviewers:

            async def review_node(state, runtime, reviewer_id=reviewer):
                _, spec = nodes[reviewer_id]
                prompt = HumanMessage(f"Review this artifact:\n{state.get('artifact', '')}")
                result = await self._chat_node(spec, client_for(spec), stream=False)(
                    {**state, "messages": [prompt]}, runtime
                )
                return {"reviews": {reviewer_id: str(result["messages"][-1].content)}}

            graph.add_node(reviewer, review_node)

        async def judge_node(state, runtime):
            _, spec = nodes[judge]
            prompt = HumanMessage(
                "Produce the final answer from the artifact and reviews:\n"
                + json.dumps(
                    {"artifact": state.get("artifact"), "reviews": state.get("reviews", {})},
                    ensure_ascii=False,
                )
            )
            return await self._chat_node(spec, client_for(spec))(
                {**state, "messages": [prompt]}, runtime
            )

        graph.add_node(judge, judge_node)
        graph.add_conditional_edges(
            source, lambda state: [Send(name, dict(state)) for name in reviewers]
        )
        graph.add_edge(tuple(reviewers), judge).add_edge(judge, END).add_edge(START, source)
        return graph

    def _plan_execute(self, draft, nodes, client_for):
        graph = StateGraph(GraphState, context_schema=GraphContext, name="plan-execute")
        planner = next(node_id for node_id, (node, _) in nodes.items() if node.role == "planner")
        executor = next(node_id for node_id, (node, _) in nodes.items() if node.role == "executor")
        replanner = next(
            node_id for node_id, (node, _) in nodes.items() if node.role == "replanner"
        )
        max_turns = int(draft.settings.get("max_turns", 4))

        async def planner_node(state, runtime):
            _, spec = nodes[planner]
            result = await self._chat_node(spec, client_for(spec), stream=False)(state, runtime)
            return {**result, "plan": str(result["messages"][-1].content), "turn": 0}

        async def executor_node(state, runtime):
            _, spec = nodes[executor]
            prompt = HumanMessage(f"Execute this plan:\n{state.get('plan', '')}")
            result = await self._agent_node(spec, client_for(spec), stream=False)(
                {**state, "messages": [prompt]}, runtime
            )
            return {**result, "execution": str(result["messages"][-1].content)}

        async def replanner_node(state, runtime):
            _, spec = nodes[replanner]
            prompt = HumanMessage(
                "Return JSON with done, response and optional next_plan:\n"
                + json.dumps(
                    {"plan": state.get("plan"), "execution": state.get("execution")},
                    ensure_ascii=False,
                )
            )
            return await self._chat_node(spec, client_for(spec), stream=False)(
                {**state, "messages": [prompt]}, runtime
            )

        def route(state):
            turn = int(state.get("turn", 0)) + 1
            latest = state.get("messages", [])[-1]
            parsed = parse_control(str(getattr(latest, "content", ""))) or {}
            if bool(parsed.get("done", True)) or turn >= max_turns:
                response = str(parsed.get("response") or getattr(latest, "content", ""))
                return Command(update={"turn": turn, "messages": [AIMessage(response)]}, goto=END)
            return Command(
                update={"turn": turn, "plan": str(parsed.get("next_plan", ""))}, goto=executor
            )

        graph.add_node(planner, planner_node)
        graph.add_node(executor, executor_node)
        graph.add_node(replanner, replanner_node)
        graph.add_node("replan_decision", route, destinations=(executor, END))
        graph.add_edge(START, planner).add_edge(planner, executor)
        graph.add_edge(executor, replanner).add_edge(replanner, "replan_decision")
        return graph
