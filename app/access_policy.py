from __future__ import annotations

from collections.abc import Iterable, Mapping
from typing import Any

AUDIENCE_ROLES = ("teacher", "student", "user")
DEFAULT_AUDIENCE_ROLES = AUDIENCE_ROLES


def audience_roles_from_config(config: Mapping[str, Any]) -> tuple[str, ...]:
    """Read revision audience metadata while keeping legacy revisions public."""
    if "audience_roles" not in config:
        return DEFAULT_AUDIENCE_ROLES
    raw_roles = config.get("audience_roles")
    if not isinstance(raw_roles, (list, tuple)):
        return ()
    return tuple(dict.fromkeys(role for role in raw_roles if role in AUDIENCE_ROLES))


def can_access_orchestration(user_role: str, audience_roles: Iterable[str]) -> bool:
    if user_role == "admin":
        return True
    if user_role not in AUDIENCE_ROLES:
        return False
    return user_role in set(audience_roles)


def can_access_revision(user_role: str, config: Mapping[str, Any]) -> bool:
    return can_access_orchestration(user_role, audience_roles_from_config(config))
