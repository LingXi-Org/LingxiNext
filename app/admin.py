from __future__ import annotations

import uuid
from pathlib import Path

import httpx
from fastapi import APIRouter, Depends, Header, HTTPException, Request
from fastapi.responses import HTMLResponse
from fastapi.templating import Jinja2Templates
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from .bridge import graph_manager
from .db import ping_database, session_scope
from .graph_templates import GraphCompiler, validate_draft
from .models import (
    AgentDefinition,
    AuditLog,
    CozeConnection,
    Orchestration,
    OrchestrationRevision,
    PlatformUser,
)
from .repository import (
    agent_payload,
    audit,
    connection_payload,
    orchestration_payload,
    publish_revision,
)
from .schemas import (
    AgentInput,
    CozeConnectionInput,
    DraftUpdate,
    OrchestrationCreate,
    OrchestrationDraft,
    UserInput,
)
from .security import csrf_token, hash_password, require_admin, require_csrf, token_cipher

router = APIRouter()
templates = Jinja2Templates(directory=Path(__file__).parent / "templates")


def admin_guard(request: Request):
    return require_admin(request)


def write_guard(request: Request):
    user = require_admin(request)
    require_csrf(request)
    return user


@router.get("/health/live")
async def live() -> dict[str, str]:
    return {"status": "ok"}


@router.get("/health/ready")
async def ready() -> dict[str, str]:
    await ping_database()
    return {"status": "ready"}


@router.get("/admin", response_class=HTMLResponse)
async def admin_page(request: Request):
    try:
        user = require_admin(request)
    except HTTPException:
        return HTMLResponse(
            '<!doctype html><meta charset="utf-8"><title>LingxiNext</title>'
            "<style>body{font:16px system-ui;display:grid;place-items:center;height:100vh;background:#0b1020;color:#fff}"
            'a{color:#8be9fd}</style><p>请先在 <a href="/">LingxiNext</a> 登录管理员账户。</p>',
            status_code=401,
        )
    return templates.TemplateResponse(
        request,
        "admin.html",
        {"username": user.username, "csrf_token": csrf_token(request)},
    )


@router.get("/api/admin/bootstrap")
async def bootstrap(request: Request, session: AsyncSession = Depends(session_scope)):
    user = require_admin(request)
    counts = {}
    for name, model in (
        ("connections", CozeConnection),
        ("agents", AgentDefinition),
        ("orchestrations", Orchestration),
        ("users", PlatformUser),
    ):
        counts[name] = await session.scalar(select(func.count()).select_from(model))
    return {
        "user": {"username": user.username, "role": user.role},
        "csrf": csrf_token(request),
        "counts": counts,
    }


@router.get("/api/admin/connections")
async def list_connections(
    _user=Depends(admin_guard), session: AsyncSession = Depends(session_scope)
):
    rows = (await session.scalars(select(CozeConnection).order_by(CozeConnection.name))).all()
    return {"items": [connection_payload(row) for row in rows]}


@router.post("/api/admin/connections", status_code=201)
async def create_connection(
    body: CozeConnectionInput,
    user=Depends(write_guard),
    session: AsyncSession = Depends(session_scope),
):
    if not body.token:
        raise HTTPException(422, detail="token_required")
    item = CozeConnection(
        name=body.name,
        base_url=body.base_url,
        token_ciphertext=token_cipher().encrypt(body.token),
        token_expires_at=body.token_expires_at,
        enabled=body.enabled,
    )
    session.add(item)
    await session.flush()
    await audit(session, user.username, "connection.create", "connection", str(item.id))
    try:
        await session.commit()
    except IntegrityError as exc:
        raise HTTPException(409, detail="connection_name_exists") from exc
    return connection_payload(item)


@router.put("/api/admin/connections/{connection_id}")
async def update_connection(
    connection_id: uuid.UUID,
    body: CozeConnectionInput,
    user=Depends(write_guard),
    session: AsyncSession = Depends(session_scope),
):
    item = await session.get(CozeConnection, connection_id)
    if item is None:
        raise HTTPException(404, detail="connection_not_found")
    item.name, item.base_url, item.enabled = body.name, body.base_url, body.enabled
    item.token_expires_at = body.token_expires_at
    if body.token:
        item.token_ciphertext = token_cipher().encrypt(body.token)
    await audit(session, user.username, "connection.update", "connection", str(item.id))
    await session.commit()
    await graph_manager.invalidate()
    return connection_payload(item)


@router.delete("/api/admin/connections/{connection_id}", status_code=204)
async def delete_connection(
    connection_id: uuid.UUID,
    user=Depends(write_guard),
    session: AsyncSession = Depends(session_scope),
):
    item = await session.get(CozeConnection, connection_id)
    if item is None:
        raise HTTPException(404, detail="connection_not_found")
    await session.delete(item)
    await audit(session, user.username, "connection.delete", "connection", str(item.id))
    try:
        await session.commit()
    except IntegrityError as exc:
        raise HTTPException(409, detail="connection_in_use") from exc


@router.post("/api/admin/connections/{connection_id}/test")
async def test_connection(
    connection_id: uuid.UUID,
    _user=Depends(write_guard),
    session: AsyncSession = Depends(session_scope),
):
    item = await session.get(CozeConnection, connection_id)
    if item is None:
        raise HTTPException(404, detail="connection_not_found")
    token = token_cipher().decrypt(item.token_ciphertext)
    try:
        async with httpx.AsyncClient(base_url=item.base_url, timeout=15) as client:
            response = await client.get(
                "/v1/space/list",
                params={"page_num": 1, "page_size": 1},
                headers={"Authorization": f"Bearer {token}"},
            )
        return {
            "ok": response.is_success,
            "status_code": response.status_code,
            "message": "连接和凭据有效" if response.is_success else "Coze 拒绝了连接或凭据",
        }
    except httpx.HTTPError as exc:
        return {"ok": False, "status_code": None, "message": f"连接失败: {type(exc).__name__}"}


@router.get("/api/admin/agents")
async def list_agents(_user=Depends(admin_guard), session: AsyncSession = Depends(session_scope)):
    rows = (
        (await session.scalars(select(AgentDefinition).order_by(AgentDefinition.display_name)))
        .unique()
        .all()
    )
    return {"items": [agent_payload(row) for row in rows]}


@router.post("/api/admin/agents", status_code=201)
async def create_agent(
    body: AgentInput,
    user=Depends(write_guard),
    session: AsyncSession = Depends(session_scope),
):
    if await session.get(CozeConnection, body.connection_id) is None:
        raise HTTPException(422, detail="connection_not_found")
    item = AgentDefinition(**body.model_dump())
    session.add(item)
    await session.flush()
    await audit(session, user.username, "agent.create", "agent", str(item.id))
    try:
        await session.commit()
    except IntegrityError as exc:
        raise HTTPException(409, detail="agent_slug_exists") from exc
    await session.refresh(item, attribute_names=["connection"])
    return agent_payload(item)


@router.put("/api/admin/agents/{agent_id}")
async def update_agent(
    agent_id: uuid.UUID,
    body: AgentInput,
    user=Depends(write_guard),
    session: AsyncSession = Depends(session_scope),
):
    item = await session.get(AgentDefinition, agent_id)
    if item is None:
        raise HTTPException(404, detail="agent_not_found")
    for key, value in body.model_dump().items():
        setattr(item, key, value)
    await audit(session, user.username, "agent.update", "agent", str(item.id))
    await session.commit()
    await graph_manager.invalidate()
    await session.refresh(item, attribute_names=["connection"])
    return agent_payload(item)


@router.delete("/api/admin/agents/{agent_id}", status_code=204)
async def delete_agent(
    agent_id: uuid.UUID,
    user=Depends(write_guard),
    session: AsyncSession = Depends(session_scope),
):
    item = await session.get(AgentDefinition, agent_id)
    if item is None:
        raise HTTPException(404, detail="agent_not_found")
    revisions = (await session.scalars(select(OrchestrationRevision.config))).all()
    in_use = any(str(agent_id) in str(config) for config in revisions)
    if in_use:
        raise HTTPException(409, detail="agent_used_by_published_revision")
    await session.delete(item)
    await audit(session, user.username, "agent.delete", "agent", str(item.id))
    await session.commit()
    await graph_manager.invalidate()


@router.get("/api/admin/orchestrations")
async def list_orchestrations(
    _user=Depends(admin_guard), session: AsyncSession = Depends(session_scope)
):
    rows = (await session.scalars(select(Orchestration).order_by(Orchestration.name))).all()
    return {"items": [orchestration_payload(row) for row in rows]}


@router.post("/api/admin/orchestrations", status_code=201)
async def create_orchestration(
    body: OrchestrationCreate,
    user=Depends(write_guard),
    session: AsyncSession = Depends(session_scope),
):
    item = Orchestration(
        slug=body.slug,
        name=body.name,
        description=body.description,
        draft=body.draft.model_dump(mode="json"),
        enabled=body.enabled,
    )
    session.add(item)
    await session.flush()
    await audit(session, user.username, "orchestration.create", "orchestration", str(item.id))
    try:
        await session.commit()
    except IntegrityError as exc:
        raise HTTPException(409, detail="orchestration_slug_exists") from exc
    return orchestration_payload(item)


@router.get("/api/admin/orchestrations/{orchestration_id}")
async def get_orchestration(
    orchestration_id: uuid.UUID,
    _user=Depends(admin_guard),
    session: AsyncSession = Depends(session_scope),
):
    item = await session.get(Orchestration, orchestration_id)
    if item is None:
        raise HTTPException(404, detail="orchestration_not_found")
    return orchestration_payload(item)


@router.put("/api/admin/orchestrations/{orchestration_id}/draft")
async def update_draft(
    orchestration_id: uuid.UUID,
    body: DraftUpdate,
    if_match: str | None = Header(default=None),
    user=Depends(write_guard),
    session: AsyncSession = Depends(session_scope),
):
    item = await session.get(Orchestration, orchestration_id, with_for_update=True)
    if item is None:
        raise HTTPException(404, detail="orchestration_not_found")
    expected = str(item.draft_version)
    if if_match is None or if_match.strip('"') != expected:
        raise HTTPException(
            409, detail={"code": "draft_version_conflict", "current": item.draft_version}
        )
    item.draft = body.draft.model_dump(mode="json")
    item.draft_version += 1
    if body.name is not None:
        item.name = body.name
    if body.description is not None:
        item.description = body.description
    await audit(session, user.username, "orchestration.draft.update", "orchestration", str(item.id))
    await session.commit()
    return orchestration_payload(item)


async def _validate_item(session: AsyncSession, item: Orchestration):
    draft = OrchestrationDraft.model_validate(item.draft)
    compiler = GraphCompiler()
    specs = await compiler.load_agent_specs(session, draft)
    return validate_draft(draft, specs)


@router.post("/api/admin/orchestrations/{orchestration_id}/validate")
async def validate_orchestration(
    orchestration_id: uuid.UUID,
    _user=Depends(write_guard),
    session: AsyncSession = Depends(session_scope),
):
    item = await session.get(Orchestration, orchestration_id)
    if item is None:
        raise HTTPException(404, detail="orchestration_not_found")
    return await _validate_item(session, item)


@router.post("/api/admin/orchestrations/{orchestration_id}/publish")
async def publish_orchestration(
    orchestration_id: uuid.UUID,
    user=Depends(write_guard),
    session: AsyncSession = Depends(session_scope),
):
    item = await session.get(Orchestration, orchestration_id, with_for_update=True)
    if item is None:
        raise HTTPException(404, detail="orchestration_not_found")
    validation = await _validate_item(session, item)
    if not validation.valid:
        raise HTTPException(422, detail=validation.model_dump())
    revision = await publish_revision(session, item, user.username)
    await session.flush()
    compiled = await GraphCompiler().compile(session, revision)
    await compiled.close()
    await session.commit()
    return {
        "revision_id": str(revision.id),
        "version": revision.version,
        "digest": revision.digest,
        "diagram": validation.diagram,
    }


@router.post("/api/admin/orchestrations/{orchestration_id}/toggle")
async def toggle_orchestration(
    orchestration_id: uuid.UUID,
    user=Depends(write_guard),
    session: AsyncSession = Depends(session_scope),
):
    item = await session.get(Orchestration, orchestration_id)
    if item is None:
        raise HTTPException(404, detail="orchestration_not_found")
    item.enabled = not item.enabled
    await audit(
        session,
        user.username,
        "orchestration.toggle",
        "orchestration",
        str(item.id),
        {"enabled": item.enabled},
    )
    await session.commit()
    return orchestration_payload(item)


@router.get("/api/admin/orchestrations/{orchestration_id}/revisions")
async def revisions(
    orchestration_id: uuid.UUID,
    _user=Depends(admin_guard),
    session: AsyncSession = Depends(session_scope),
):
    rows = (
        await session.scalars(
            select(OrchestrationRevision)
            .where(OrchestrationRevision.orchestration_id == orchestration_id)
            .order_by(OrchestrationRevision.version.desc())
        )
    ).all()
    return {
        "items": [
            {
                "id": str(row.id),
                "version": row.version,
                "digest": row.digest,
                "published_by": row.published_by,
                "published_at": row.published_at,
            }
            for row in rows
        ]
    }


@router.get("/api/admin/users")
async def list_users(_user=Depends(admin_guard), session: AsyncSession = Depends(session_scope)):
    rows = (await session.scalars(select(PlatformUser).order_by(PlatformUser.username))).all()
    return {
        "items": [
            {
                "id": str(row.id),
                "username": row.username,
                "role": row.role,
                "active": row.active,
                "created_at": row.created_at,
            }
            for row in rows
        ]
    }


@router.post("/api/admin/users", status_code=201)
async def create_user(
    body: UserInput,
    user=Depends(write_guard),
    session: AsyncSession = Depends(session_scope),
):
    item = PlatformUser(
        username=body.username,
        password_hash=hash_password(body.password),
        role=body.role,
        active=body.active,
    )
    session.add(item)
    await audit(session, user.username, "user.create", "user", body.username, {"role": body.role})
    try:
        await session.commit()
    except IntegrityError as exc:
        raise HTTPException(409, detail="username_exists") from exc
    return {"id": str(item.id), "username": item.username, "role": item.role, "active": item.active}


@router.put("/api/admin/users/{user_id}")
async def update_user(
    user_id: uuid.UUID,
    body: UserInput,
    actor=Depends(write_guard),
    session: AsyncSession = Depends(session_scope),
):
    item = await session.get(PlatformUser, user_id)
    if item is None:
        raise HTTPException(404, detail="user_not_found")
    item.username = body.username
    item.password_hash = hash_password(body.password)
    item.role = body.role
    item.active = body.active
    await audit(session, actor.username, "user.update", "user", body.username, {"role": body.role})
    await session.commit()
    return {"id": str(item.id), "username": item.username, "role": item.role, "active": item.active}


@router.delete("/api/admin/users/{user_id}", status_code=204)
async def remove_user(
    user_id: uuid.UUID,
    actor=Depends(write_guard),
    session: AsyncSession = Depends(session_scope),
):
    item = await session.get(PlatformUser, user_id)
    if item is None:
        raise HTTPException(404, detail="user_not_found")
    if item.username == actor.username:
        raise HTTPException(409, detail="cannot_delete_current_user")
    if item.role == "admin":
        admins = await session.scalar(
            select(func.count()).select_from(PlatformUser).where(PlatformUser.role == "admin")
        )
        if int(admins or 0) <= 1:
            raise HTTPException(409, detail="cannot_delete_last_admin")
    await audit(session, actor.username, "user.delete", "user", item.username)
    await session.delete(item)
    await session.commit()


@router.get("/api/admin/audit")
async def list_audit(
    limit: int = 100,
    _user=Depends(admin_guard),
    session: AsyncSession = Depends(session_scope),
):
    limit = max(1, min(limit, 500))
    rows = (await session.scalars(select(AuditLog).order_by(AuditLog.id.desc()).limit(limit))).all()
    return {
        "items": [
            {
                "id": row.id,
                "actor": row.actor,
                "action": row.action,
                "resource_type": row.resource_type,
                "resource_id": row.resource_id,
                "detail": row.detail,
                "created_at": row.created_at,
            }
            for row in rows
        ]
    }
