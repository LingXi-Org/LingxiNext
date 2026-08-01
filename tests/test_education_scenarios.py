from __future__ import annotations

import uuid

import pytest
from lingxigraph.integrations import AsyncCozeClient

from app.admin import router
from app.education_scenarios import (
    STUDENT_LEARNING_COMPANION,
    TEACHER_LESSON_REVIEW,
    build_scenario_draft,
    list_education_scenarios,
)
from app.graph_templates import AgentSpec, GraphCompiler, validate_draft


def _mapping(scenario) -> dict[str, uuid.UUID]:
    return {role.key: uuid.uuid4() for role in scenario.roles}


def _specs(draft, kind: str = "coze_chat") -> dict[str, AgentSpec]:
    return {
        str(node.agent_id): AgentSpec(
            id=str(node.agent_id),
            slug=node.id,
            display_name=node.id,
            kind=kind,
            remote_id=f"remote-{node.id}",
            base_url="https://api.coze.cn",
            token="test-token",
            timeout_seconds=10,
            max_retries=0,
        )
        for node in draft.nodes
    }


@pytest.mark.parametrize(
    ("scenario", "template", "audience", "node_count", "edge_count"),
    [
        (STUDENT_LEARNING_COMPANION, "supervisor", ["student"], 5, 8),
        (TEACHER_LESSON_REVIEW, "parallel_review", ["teacher"], 5, 6),
    ],
)
def test_scenario_drafts_are_complete_and_pass_safe_template_validation(
    scenario, template, audience, node_count, edge_count
) -> None:
    draft = build_scenario_draft(scenario, _mapping(scenario))
    assert draft.scenario_key == scenario.key
    assert draft.template == template
    assert draft.audience_roles == audience
    assert len(draft.nodes) == node_count
    assert len(draft.edges) == edge_count
    assert all(node.config["instructions"] for node in draft.nodes)
    result = validate_draft(draft, _specs(draft))
    assert result.valid, result.issues


def test_scenario_mapping_must_be_exact_and_metadata_has_no_agent_ids() -> None:
    with pytest.raises(ValueError, match="agent_mapping mismatch"):
        build_scenario_draft(STUDENT_LEARNING_COMPANION, {})
    payloads = [scenario.payload() for scenario in list_education_scenarios()]
    assert {item["key"] for item in payloads} == {
        "student_learning_companion",
        "teacher_lesson_review",
    }
    assert "agent_id" not in str(payloads)


def test_admin_education_api_contract_is_registered() -> None:
    methods_by_path = {route.path: getattr(route, "methods", set()) for route in router.routes}
    assert methods_by_path["/api/admin/education/scenarios"] == {"GET"}
    assert methods_by_path["/api/admin/orchestrations/from-scenario"] == {"POST"}


def test_education_scenarios_reject_workflow_agents() -> None:
    scenario = STUDENT_LEARNING_COMPANION
    draft = build_scenario_draft(scenario, _mapping(scenario))
    result = validate_draft(draft, _specs(draft, "coze_workflow"))
    assert not result.valid
    assert "workflow_role_forbidden" in {issue.code for issue in result.issues}


@pytest.mark.asyncio
@pytest.mark.parametrize("scenario", [STUDENT_LEARNING_COMPANION, TEACHER_LESSON_REVIEW])
async def test_education_scenario_compiles_to_lingxigraph(scenario) -> None:
    draft = build_scenario_draft(scenario, _mapping(scenario))
    specs = _specs(draft)
    clients: list[AsyncCozeClient] = []

    def client_for(spec):
        client = AsyncCozeClient(spec.token, base_url=spec.base_url, max_retries=0)
        clients.append(client)
        return client

    nodes = {node.id: (node, specs[str(node.agent_id)]) for node in draft.nodes}
    compiled = GraphCompiler()._build(draft, nodes, client_for).compile()
    assert compiled.get_graph().nodes
    for client in clients:
        await client.aclose()
