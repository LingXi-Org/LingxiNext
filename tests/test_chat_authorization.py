from __future__ import annotations

from types import SimpleNamespace

import chainlit as cl

from app.chat import _accessible_orchestrations, _select_orchestration, _user_role


def _row(slug: str, audience_roles=None):
    config = {} if audience_roles is None else {"audience_roles": audience_roles}
    return SimpleNamespace(slug=slug), SimpleNamespace(config=config)


def test_profile_rows_are_filtered_by_current_user_role() -> None:
    rows = [
        _row("teacher-only", ["teacher"]),
        _row("student-only", ["student"]),
        _row("public"),
    ]
    assert [row[0].slug for row in _accessible_orchestrations(rows, "teacher")] == [
        "teacher-only",
        "public",
    ]
    assert [row[0].slug for row in _accessible_orchestrations(rows, "student")] == [
        "student-only",
        "public",
    ]
    assert len(_accessible_orchestrations(rows, "admin")) == 3


def test_forged_profile_slug_is_rejected_server_side() -> None:
    rows = [_row("teacher-only", ["teacher"]), _row("student-only", ["student"])]
    selected, forbidden = _select_orchestration(rows, "student", "teacher-only")
    assert selected is None
    assert forbidden

    selected, forbidden = _select_orchestration(rows, "student", "student-only")
    assert selected is rows[1]
    assert not forbidden


def test_chainlit_user_role_comes_from_authenticated_metadata() -> None:
    assert _user_role(cl.User(identifier="teacher", metadata={"role": "teacher"})) == "teacher"
    assert _user_role(None) == ""
