from __future__ import annotations

import json
import platform
import shutil
import sys
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path

import httpx
import psutil
from fastapi import APIRouter, Depends, Header, HTTPException, Request
from fastapi.responses import HTMLResponse
from fastapi.templating import Jinja2Templates
from sqlalchemy import func, select, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from .bridge import graph_manager
from .db import engine, ping_database, session_scope
from .graph_templates import (
    EDGE_RULES,
    ROLE_RULES,
    WORKFLOW_ROLES,
    GraphCompiler,
    validate_draft,
)
from .models import (
    AgentDefinition,
    AuditLog,
    CozeConnection,
    Orchestration,
    OrchestrationRevision,
    PlatformUser,
    ThreadBinding,
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
    UserUpdate,
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
            '<!doctype html><meta charset="utf-8"><title>LingxiNext 控制台</title>'
            "<style>body{font:15px/1.6 system-ui;display:grid;place-items:center;height:100vh;"
            "margin:0;background:#f6f7f9;color:#17181c}div{text-align:center}"
            "a{color:#4f5ce5;font-weight:600}</style>"
            '<div><p>访问控制台需要管理员身份。</p><p>请先在 <a href="/">LingxiNext</a> 登录管理员账户。</p></div>',
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


_PROCESS = psutil.Process()
_STARTED_AT = datetime.now(timezone.utc)


@router.get("/api/admin/system")
async def system_status(
    _user=Depends(admin_guard), session: AsyncSession = Depends(session_scope)
):
    with _PROCESS.oneshot():
        memory = _PROCESS.memory_info()
        process_cpu = _PROCESS.cpu_percent(interval=None)
        process_threads = _PROCESS.num_threads()
    virtual = psutil.virtual_memory()
    disk = shutil.disk_usage(Path.cwd())
    try:
        load_1, load_5, load_15 = psutil.getloadavg()
    except (AttributeError, OSError):
        load_1 = load_5 = load_15 = None

    database: dict[str, object] = {"ok": True, "latency_ms": None}
    counts: dict[str, int] = {}
    started = time.perf_counter()
    try:
        await session.execute(text("SELECT 1"))
        database["latency_ms"] = round((time.perf_counter() - started) * 1000, 1)
        database["size_bytes"] = await session.scalar(
            text("SELECT pg_database_size(current_database())")
        )
        for key, sql in (
            ("threads", "SELECT count(*) FROM threads"),
            ("steps", "SELECT count(*) FROM steps"),
            ("thread_bindings", "SELECT count(*) FROM thread_bindings"),
            ("audit_logs", "SELECT count(*) FROM audit_logs"),
        ):
            counts[key] = int(await session.scalar(text(sql)) or 0)
    except Exception:  # noqa: BLE001 - 监控端点必须在数据库故障时也能响应
        database["ok"] = False

    pool_stats: dict[str, int] | None = None
    pool = getattr(engine, "pool", None)
    if pool is not None:
        try:
            pool_stats = {
                "size": pool.size(),
                "checked_out": pool.checkedout(),
                "checked_in": pool.checkedin(),
                "overflow": pool.overflow(),
            }
        except Exception:  # noqa: BLE001
            pool_stats = None

    return {
        "app": {
            "version": "0.1.0",
            "python": sys.version.split()[0],
            "platform": f"{platform.system()} {platform.release()}",
            "started_at": _STARTED_AT,
            "uptime_seconds": int((datetime.now(timezone.utc) - _STARTED_AT).total_seconds()),
            "compiled_graphs": graph_manager.cache_size(),
        },
        "process": {
            "rss_bytes": memory.rss,
            "cpu_percent": process_cpu,
            "threads": process_threads,
        },
        "system": {
            "cpu_percent": psutil.cpu_percent(interval=None),
            "cpu_count": psutil.cpu_count() or 0,
            "load_1m": load_1,
            "load_5m": load_5,
            "load_15m": load_15,
            "mem_total": virtual.total,
            "mem_used": virtual.used,
            "mem_percent": virtual.percent,
            "disk_total": disk.total,
            "disk_used": disk.used,
            "disk_percent": round(disk.used / disk.total * 100, 1) if disk.total else 0,
        },
        "database": {**database, "pool": pool_stats, "counts": counts},
    }


@router.get("/api/admin/meta")
async def orchestration_meta(_user=Depends(admin_guard)):
    return {
        "templates": {
            template: {
                "roles": {
                    role: {"min": bounds[0], "max": bounds[1]} for role, bounds in rules.items()
                },
                "edges": sorted(EDGE_RULES[template]),
                "workflow_roles": sorted(WORKFLOW_ROLES.get(template, set())),
            }
            for template, rules in ROLE_RULES.items()
        }
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


@router.delete("/api/admin/orchestrations/{orchestration_id}", status_code=204)
async def delete_orchestration(
    orchestration_id: uuid.UUID,
    user=Depends(write_guard),
    session: AsyncSession = Depends(session_scope),
):
    item = await session.get(Orchestration, orchestration_id)
    if item is None:
        raise HTTPException(404, detail="orchestration_not_found")
    revision_ids = (
        await session.scalars(
            select(OrchestrationRevision.id).where(
                OrchestrationRevision.orchestration_id == orchestration_id
            )
        )
    ).all()
    await session.delete(item)
    await audit(session, user.username, "orchestration.delete", "orchestration", str(item.id))
    await session.commit()
    for revision_id in revision_ids:
        await graph_manager.invalidate(str(revision_id))


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


@router.get("/api/admin/orchestrations/{orchestration_id}/revisions/{revision_id}")
async def revision_detail(
    orchestration_id: uuid.UUID,
    revision_id: uuid.UUID,
    _user=Depends(admin_guard),
    session: AsyncSession = Depends(session_scope),
):
    row = await session.get(OrchestrationRevision, revision_id)
    if row is None or row.orchestration_id != orchestration_id:
        raise HTTPException(404, detail="revision_not_found")
    return {
        "id": str(row.id),
        "version": row.version,
        "digest": row.digest,
        "config": row.config,
        "published_by": row.published_by,
        "published_at": row.published_at,
    }


@router.post("/api/admin/orchestrations/{orchestration_id}/revisions/{revision_id}/restore")
async def restore_revision(
    orchestration_id: uuid.UUID,
    revision_id: uuid.UUID,
    user=Depends(write_guard),
    session: AsyncSession = Depends(session_scope),
):
    item = await session.get(Orchestration, orchestration_id, with_for_update=True)
    if item is None:
        raise HTTPException(404, detail="orchestration_not_found")
    revision = await session.get(OrchestrationRevision, revision_id)
    if revision is None or revision.orchestration_id != orchestration_id:
        raise HTTPException(404, detail="revision_not_found")
    item.draft = revision.config
    item.draft_version += 1
    await audit(
        session,
        user.username,
        "orchestration.draft.restore",
        "orchestration",
        str(item.id),
        {"revision_id": str(revision.id), "version": revision.version},
    )
    await session.commit()
    return orchestration_payload(item)


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
    body: UserUpdate,
    actor=Depends(write_guard),
    session: AsyncSession = Depends(session_scope),
):
    item = await session.get(PlatformUser, user_id)
    if item is None:
        raise HTTPException(404, detail="user_not_found")
    if item.role == "admin" and (body.role != "admin" or not body.active):
        admins = await session.scalar(
            select(func.count())
            .select_from(PlatformUser)
            .where(PlatformUser.role == "admin", PlatformUser.active.is_(True))
        )
        if int(admins or 0) <= 1:
            raise HTTPException(409, detail="cannot_demote_last_admin")
    item.username = body.username
    if body.password:
        item.password_hash = hash_password(body.password)
    item.role = body.role
    item.active = body.active
    await audit(session, actor.username, "user.update", "user", body.username, {"role": body.role})
    try:
        await session.commit()
    except IntegrityError as exc:
        raise HTTPException(409, detail="username_exists") from exc
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


@router.get("/api/admin/sessions")
async def list_sessions(
    limit: int = 50,
    q: str = "",
    orchestration_id: uuid.UUID | None = None,
    _user=Depends(admin_guard),
    session: AsyncSession = Depends(session_scope),
):
    limit = max(1, min(limit, 200))
    sql = """
        SELECT t.id, t."createdAt" AS created_at, t.name, t."userIdentifier" AS user_identifier,
               b.orchestration_id::text AS orchestration_id, b.revision_id::text AS revision_id,
               b.username,
               (SELECT count(*) FROM steps s
                 WHERE s."threadId" = t.id
                   AND s.type IN ('user_message', 'assistant_message')) AS message_count
        FROM threads t
        LEFT JOIN thread_bindings b ON b.thread_id = t.id
        WHERE (:q = '' OR t."userIdentifier" ILIKE :like OR t.name ILIKE :like)
          AND (:oid IS NULL OR b.orchestration_id = CAST(:oid AS uuid))
        ORDER BY t."createdAt" DESC NULLS LAST
        LIMIT :limit
    """
    rows = (
        await session.execute(
            text(sql),
            {
                "q": q,
                "like": f"%{q}%",
                "oid": str(orchestration_id) if orchestration_id else None,
                "limit": limit,
            },
        )
    ).mappings()
    items = [dict(row) for row in rows]

    orchestration_ids = {item["orchestration_id"] for item in items if item["orchestration_id"]}
    revision_ids = {item["revision_id"] for item in items if item["revision_id"]}
    names: dict[str, str] = {}
    versions: dict[str, int] = {}
    if orchestration_ids:
        for row in await session.execute(
            select(Orchestration.id, Orchestration.name).where(
                Orchestration.id.in_([uuid.UUID(x) for x in orchestration_ids])
            )
        ):
            names[str(row.id)] = row.name
    if revision_ids:
        for rev_row in await session.execute(
            select(OrchestrationRevision.id, OrchestrationRevision.version).where(
                OrchestrationRevision.id.in_([uuid.UUID(x) for x in revision_ids])
            )
        ):
            versions[str(rev_row.id)] = rev_row.version
    for item in items:
        item["orchestration_name"] = names.get(item["orchestration_id"])
        item["revision_version"] = versions.get(item["revision_id"])
    return {"items": items}


@router.get("/api/admin/sessions/{thread_id}")
async def session_detail(
    thread_id: str,
    user=Depends(admin_guard),
    session: AsyncSession = Depends(session_scope),
):
    thread = (
        await session.execute(
            text(
                'SELECT t.id, t."createdAt" AS created_at, t.name, '
                't."userIdentifier" AS user_identifier FROM threads t WHERE t.id = :tid'
            ),
            {"tid": thread_id},
        )
    ).mappings().first()
    if thread is None:
        raise HTTPException(404, detail="session_not_found")
    binding = await session.get(ThreadBinding, thread_id)
    orchestration = None
    version = None
    if binding is not None:
        item = await session.get(Orchestration, binding.orchestration_id)
        orchestration = item.name if item else None
        revision = await session.get(OrchestrationRevision, binding.revision_id)
        version = revision.version if revision else None
    step_rows = (
        await session.execute(
            text(
                'SELECT s.id, s.name, s.type, s."parentId" AS parent_id, s."isError" AS is_error, '
                's.input, s.output, s.metadata, s."createdAt" AS created_at, s.start, '
                's."end" AS finish '
                'FROM steps s WHERE s."threadId" = :tid ORDER BY s."createdAt" ASC NULLS LAST'
            ),
            {"tid": thread_id},
        )
    ).mappings()
    steps = []
    for row in step_rows:
        step_item: dict[str, object] = dict(row)
        raw_meta = step_item.get("metadata")
        if isinstance(raw_meta, str) and raw_meta:
            try:
                step_item["metadata"] = json.loads(raw_meta)
            except ValueError:
                step_item["metadata"] = {"raw": raw_meta[:2000]}
        steps.append(step_item)
    await audit(session, user.username, "session.view", "session", thread_id)
    await session.commit()
    return {
        "id": thread["id"],
        "name": thread["name"],
        "created_at": thread["created_at"],
        "user_identifier": thread["user_identifier"],
        "username": binding.username if binding else None,
        "orchestration_name": orchestration,
        "revision_version": version,
        "steps": steps,
    }


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
