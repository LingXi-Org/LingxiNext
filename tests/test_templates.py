from __future__ import annotations

import uuid

import pytest
from lingxigraph.integrations import AsyncCozeClient

from app.graph_templates import AgentSpec, GraphCompiler, parse_control, validate_draft
from app.schemas import DraftEdge, DraftNode, OrchestrationDraft


def agent(kind: str = "coze_chat") -> AgentSpec:
    identifier = str(uuid.uuid4())
    return AgentSpec(
        id=identifier,
        slug=f"agent_{identifier[:8]}",
        display_name="Agent",
        kind=kind,
        remote_id="remote-id",
        base_url="https://api.coze.cn",
        token="test-token",
        timeout_seconds=10,
        max_retries=0,
    )


def node(node_id: str, role: str, spec: AgentSpec, x: int = 0) -> DraftNode:
    return DraftNode(id=node_id, role=role, agent_id=uuid.UUID(spec.id), position={"x": x, "y": 0})


@pytest.mark.parametrize(
    ("template", "roles", "edges", "settings"),
    [
        ("topic_auction", [("a", "agent")], [], {"max_turns": 8}),
        (
            "supervisor",
            [("manager", "supervisor"), ("worker", "specialist")],
            [("manager", "worker"), ("worker", "manager")],
            {"max_turns": 8},
        ),
        (
            "handoff",
            [("left", "agent"), ("right", "agent")],
            [("left", "right")],
            {"max_turns": 8, "entry_node": "left"},
        ),
        (
            "parallel_review",
            [("source", "source"), ("review", "reviewer"), ("judge", "judge")],
            [("source", "review"), ("review", "judge")],
            {"max_turns": 8},
        ),
        (
            "plan_execute",
            [("planner", "planner"), ("execute", "executor"), ("replan", "replanner")],
            [("planner", "execute"), ("execute", "replan"), ("replan", "execute")],
            {"max_turns": 4},
        ),
    ],
)
def test_all_safe_templates_validate(template, roles, edges, settings) -> None:
    specs = [agent() for _ in roles]
    draft = OrchestrationDraft(
        template=template,
        nodes=[
            node(node_id, role, spec, index * 200)
            for index, ((node_id, role), spec) in enumerate(zip(roles, specs, strict=True))
        ],
        edges=[DraftEdge(source=source, target=target) for source, target in edges],
        settings=settings,
    )
    result = validate_draft(draft, {spec.id: spec for spec in specs})
    assert result.valid, result.issues
    assert "flowchart LR" in result.diagram


def test_workflow_is_rejected_from_non_leaf_role() -> None:
    supervisor, workflow = agent(), agent("coze_workflow")
    draft = OrchestrationDraft(
        template="supervisor",
        nodes=[node("manager", "supervisor", supervisor), node("worker", "specialist", workflow)],
        edges=[],
        settings={"max_turns": 4},
    )
    result = validate_draft(draft, {supervisor.id: supervisor, workflow.id: workflow})
    assert not result.valid
    assert "workflow_role_forbidden" in {issue.code for issue in result.issues}


def test_invalid_edges_and_limits_are_reported_with_stable_codes() -> None:
    spec = agent()
    draft = OrchestrationDraft(
        template="topic_auction",
        nodes=[node("one", "agent", spec)],
        edges=[DraftEdge(source="one", target="missing")],
        settings={"max_turns": 99},
    )
    codes = {issue.code for issue in validate_draft(draft, {spec.id: spec}).issues}
    assert {"unknown_endpoint", "invalid_limit"}.issubset(codes)


def test_required_topology_and_role_edges_are_enforced() -> None:
    manager, specialist = agent(), agent()
    draft = OrchestrationDraft(
        template="supervisor",
        nodes=[node("manager", "supervisor", manager), node("worker", "specialist", specialist)],
        edges=[DraftEdge(source="worker", target="worker")],
        settings={"max_turns": 4},
    )
    codes = {
        issue.code
        for issue in validate_draft(draft, {manager.id: manager, specialist.id: specialist}).issues
    }
    assert {"self_loop", "edge_forbidden", "required_edge_missing"}.issubset(codes)


def test_handoff_rejects_cycles_unknown_entries_and_unreachable_nodes() -> None:
    first, second, third = agent(), agent(), agent()
    specs = {item.id: item for item in (first, second, third)}
    draft = OrchestrationDraft(
        template="handoff",
        nodes=[
            node("first", "agent", first),
            node("second", "agent", second),
            node("third", "agent", third),
        ],
        edges=[
            DraftEdge(source="first", target="second"),
            DraftEdge(source="second", target="first"),
        ],
        settings={"max_turns": 4, "entry_node": "missing"},
    )
    codes = {issue.code for issue in validate_draft(draft, specs).issues}
    assert {"cycle_forbidden", "entry_unknown"}.issubset(codes)

    draft.settings["entry_node"] = "first"
    codes = {issue.code for issue in validate_draft(draft, specs).issues}
    assert "unreachable_node" in codes


def test_unknown_agent_kind_is_rejected() -> None:
    spec = agent()
    spec = AgentSpec(
        id=spec.id,
        slug=spec.slug,
        display_name=spec.display_name,
        kind="custom_python",
        remote_id=spec.remote_id,
        base_url=spec.base_url,
        token=spec.token,
        timeout_seconds=spec.timeout_seconds,
        max_retries=spec.max_retries,
    )
    draft = OrchestrationDraft(
        template="topic_auction",
        nodes=[node("one", "agent", spec)],
        settings={"max_turns": 4},
    )
    codes = {issue.code for issue in validate_draft(draft, {spec.id: spec}).issues}
    assert "agent_type_invalid" in codes


def test_control_json_has_safe_fallback_parser() -> None:
    assert parse_control('{"next_agent":"worker"}') == {"next_agent": "worker"}
    assert parse_control('text\n```lingxi-control\n{"next_agent":"__end__"}\n```') == {
        "next_agent": "__end__"
    }
    assert parse_control("not json") is None


@pytest.mark.asyncio
async def test_each_template_builds_a_compiled_lingxigraph() -> None:
    compiler = GraphCompiler()
    cases = [
        ("topic_auction", [("a", "agent")], [], {"max_turns": 4}),
        ("supervisor", [("m", "supervisor"), ("s", "specialist")], [], {"max_turns": 4}),
        (
            "handoff",
            [("a", "agent"), ("b", "agent")],
            [("a", "b")],
            {"max_turns": 4, "entry_node": "a"},
        ),
        (
            "parallel_review",
            [("a", "source"), ("b", "reviewer"), ("c", "judge")],
            [],
            {"max_turns": 4},
        ),
        (
            "plan_execute",
            [("a", "planner"), ("b", "executor"), ("c", "replanner")],
            [],
            {"max_turns": 4},
        ),
    ]
    for template, roles, edges, settings in cases:
        specs = [agent() for _ in roles]
        draft = OrchestrationDraft(
            template=template,
            nodes=[
                node(node_id, role, spec)
                for (node_id, role), spec in zip(roles, specs, strict=True)
            ],
            edges=[DraftEdge(source=a, target=b) for a, b in edges],
            settings=settings,
        )
        mapping = {item.id: item for item in specs}
        clients: list[AsyncCozeClient] = []

        def client_for(spec, client_bucket=clients):
            client = AsyncCozeClient(spec.token, base_url=spec.base_url, max_retries=0)
            client_bucket.append(client)
            return client

        graph = compiler._build(
            draft, {n.id: (n, mapping[str(n.agent_id)]) for n in draft.nodes}, client_for
        )
        compiled = graph.compile()
        assert compiled.get_graph().nodes
        for client in clients:
            await client.aclose()
