from __future__ import annotations

import hashlib
import json
import uuid
from typing import Any

from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from .models import (
    AgentDefinition,
    AuditLog,
    CozeConnection,
    Orchestration,
    OrchestrationRevision,
    PlatformUser,
    ThreadBinding,
)
from .security import hash_password, mask_secret, token_cipher


def digest_config(config: dict[str, Any]) -> str:
    canonical = json.dumps(config, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


async def audit(
    session: AsyncSession,
    actor: str,
    action: str,
    resource_type: str,
    resource_id: str = "",
    detail: dict[str, Any] | None = None,
) -> None:
    session.add(
        AuditLog(
            actor=actor,
            action=action,
            resource_type=resource_type,
            resource_id=resource_id,
            detail=detail or {},
        )
    )


def connection_payload(item: CozeConnection) -> dict[str, Any]:
    token = token_cipher().decrypt(item.token_ciphertext)
    return {
        "id": str(item.id),
        "name": item.name,
        "base_url": item.base_url,
        "masked_token": mask_secret(token),
        "token_expires_at": item.token_expires_at,
        "enabled": item.enabled,
        "created_at": item.created_at,
        "updated_at": item.updated_at,
    }


def agent_payload(item: AgentDefinition) -> dict[str, Any]:
    return {
        "id": str(item.id),
        "slug": item.slug,
        "display_name": item.display_name,
        "description": item.description,
        "kind": item.kind,
        "connection_id": str(item.connection_id),
        "connection_name": item.connection.name if item.connection else None,
        "remote_id": item.remote_id,
        "enabled": item.enabled,
        "timeout_seconds": item.timeout_seconds,
        "max_retries": item.max_retries,
        "created_at": item.created_at,
        "updated_at": item.updated_at,
    }


def orchestration_payload(item: Orchestration) -> dict[str, Any]:
    return {
        "id": str(item.id),
        "slug": item.slug,
        "name": item.name,
        "description": item.description,
        "draft": item.draft,
        "draft_version": item.draft_version,
        "active_revision_id": str(item.active_revision_id) if item.active_revision_id else None,
        "enabled": item.enabled,
        "created_at": item.created_at,
        "updated_at": item.updated_at,
    }


async def publish_revision(
    session: AsyncSession, orchestration: Orchestration, actor: str
) -> OrchestrationRevision:
    latest = await session.scalar(
        select(func.max(OrchestrationRevision.version)).where(
            OrchestrationRevision.orchestration_id == orchestration.id
        )
    )
    revision = OrchestrationRevision(
        orchestration_id=orchestration.id,
        version=int(latest or 0) + 1,
        digest=digest_config(orchestration.draft),
        config=orchestration.draft,
        published_by=actor,
    )
    session.add(revision)
    await session.flush()
    orchestration.active_revision_id = revision.id
    await audit(
        session,
        actor,
        "orchestration.publish",
        "orchestration",
        str(orchestration.id),
        {"revision_id": str(revision.id), "version": revision.version},
    )
    return revision


async def bootstrap_admin(session: AsyncSession, username: str, password: str) -> None:
    existing = await session.scalar(select(PlatformUser).where(PlatformUser.username == username))
    if existing is None:
        session.add(
            PlatformUser(
                username=username,
                password_hash=hash_password(password),
                role="admin",
                active=True,
            )
        )
        await audit(session, "system", "user.bootstrap", "user", username)
        await session.commit()


async def get_binding(session: AsyncSession, thread_id: str) -> ThreadBinding | None:
    return await session.get(ThreadBinding, thread_id)


async def delete_user(session: AsyncSession, user_id: uuid.UUID) -> None:
    await session.execute(delete(PlatformUser).where(PlatformUser.id == user_id))
