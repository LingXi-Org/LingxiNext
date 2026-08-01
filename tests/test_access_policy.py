from __future__ import annotations

import pytest

from app.access_policy import (
    DEFAULT_AUDIENCE_ROLES,
    audience_roles_from_config,
    can_access_orchestration,
    can_access_revision,
)
from app.schemas import OrchestrationDraft, UserInput


@pytest.mark.parametrize(
    ("role", "audience", "allowed"),
    [
        ("admin", ["student"], True),
        ("teacher", ["teacher"], True),
        ("teacher", ["student"], False),
        ("student", ["student"], True),
        ("student", ["teacher"], False),
        ("user", ["teacher", "student", "user"], True),
        ("user", ["teacher"], False),
        ("unknown", ["teacher", "student", "user"], False),
    ],
)
def test_role_access_matrix(role: str, audience: list[str], allowed: bool) -> None:
    assert can_access_orchestration(role, audience) is allowed


def test_legacy_revision_is_public_but_malformed_metadata_is_denied() -> None:
    assert audience_roles_from_config({}) == DEFAULT_AUDIENCE_ROLES
    assert can_access_revision("teacher", {})
    assert can_access_revision("student", {})
    assert can_access_revision("user", {})
    assert not can_access_revision("student", {"audience_roles": "student"})


def test_schema_supports_education_roles_and_public_draft_default() -> None:
    assert UserInput(username="teacher01", password="long-enough-password", role="teacher")
    assert UserInput(username="student01", password="long-enough-password", role="student")
    draft = OrchestrationDraft(template="topic_auction")
    assert draft.audience_roles == ["teacher", "student", "user"]
