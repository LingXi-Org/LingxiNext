from __future__ import annotations

import asyncio
from pathlib import Path
from uuid import uuid4

import chainlit as cl
from chainlit.data.sql_alchemy import SQLAlchemyDataLayer
from sqlalchemy import select

from app.access_policy import can_access_revision
from app.bridge import bridge
from app.config import get_settings
from app.db import SessionFactory
from app.models import Orchestration, OrchestrationRevision, PlatformUser, ThreadBinding
from app.repository import get_binding
from app.security import verify_password

settings = get_settings()


@cl.data_layer
def data_layer() -> SQLAlchemyDataLayer:
    return SQLAlchemyDataLayer(conninfo=settings.database_url, show_logger=False)


@cl.password_auth_callback
async def authenticate(username: str, password: str) -> cl.User | None:
    async with SessionFactory() as session:
        account = await session.scalar(
            select(PlatformUser).where(
                PlatformUser.username == username, PlatformUser.active.is_(True)
            )
        )
        if account is None or not verify_password(account.password_hash, password):
            return None
        return cl.User(identifier=account.username, metadata={"role": account.role})


@cl.set_chat_profiles
async def chat_profiles(user: cl.User | None):
    role = _user_role(user)
    async with SessionFactory() as session:
        rows = await _published_orchestrations(session)
        return [
            cl.ChatProfile(
                name=orchestration.slug,
                markdown_description=orchestration.description or orchestration.name,
            )
            for orchestration, _revision in _accessible_orchestrations(rows, role)
        ]


def _user_role(user: cl.User | None) -> str:
    metadata = getattr(user, "metadata", None) or {}
    return str(metadata.get("role", ""))


async def _published_orchestrations(session):
    return (
        await session.execute(
            select(Orchestration, OrchestrationRevision)
            .join(
                OrchestrationRevision,
                OrchestrationRevision.id == Orchestration.active_revision_id,
            )
            .where(
                Orchestration.enabled.is_(True),
                Orchestration.active_revision_id.is_not(None),
            )
            .order_by(Orchestration.name)
        )
    ).all()


def _accessible_orchestrations(rows, role: str):
    return [row for row in rows if can_access_revision(role, row[1].config)]


def _select_orchestration(rows, role: str, profile: str | None):
    if not profile:
        accessible = _accessible_orchestrations(rows, role)
        return (accessible[0] if accessible else None), False
    selected = next((row for row in rows if row[0].slug == profile), None)
    if selected is None:
        return None, False
    if not can_access_revision(role, selected[1].config):
        return None, True
    return selected, False


def _session_values() -> tuple[str, str, str | None, str]:
    chainlit_session = cl.context.session
    user = getattr(chainlit_session, "user", None)
    return (
        str(chainlit_session.thread_id),
        str(getattr(user, "identifier", "anonymous")),
        getattr(chainlit_session, "chat_profile", None),
        _user_role(user),
    )


@cl.on_chat_start
async def on_chat_start() -> None:
    thread_id, username, profile, role = _session_values()
    async with SessionFactory() as session:
        if await get_binding(session, thread_id):
            return
        rows = await _published_orchestrations(session)
        selected, forbidden = _select_orchestration(rows, role, profile)
        if forbidden:
            await cl.Message(content="你无权访问所选编排方案，请选择与你角色匹配的场景。").send()
            return
        if selected is None:
            await cl.Message(
                content="当前没有可访问的已发布编排方案，请联系管理员在 /admin 中发布。"
            ).send()
            return
        orchestration, revision = selected
        session.add(
            ThreadBinding(
                thread_id=thread_id,
                orchestration_id=orchestration.id,
                revision_id=revision.id,
                username=username,
            )
        )
        await session.commit()
        cl.user_session.set("orchestration_revision_id", str(revision.id))
        await cl.Message(content=f"已固定到 **{orchestration.name}** 的当前发布版本。").send()


@cl.on_chat_resume
async def on_chat_resume(_thread) -> None:
    thread_id, _username, _profile, _role = _session_values()
    async with SessionFactory() as session:
        binding = await get_binding(session, thread_id)
        if binding:
            cl.user_session.set("orchestration_revision_id", str(binding.revision_id))


async def _read_uploads(message: cl.Message) -> list[tuple[str, bytes, str]]:
    """Collect binary content from a message's attached file/image elements."""
    uploads: list[tuple[str, bytes, str]] = []
    for element in message.elements or ():
        content: bytes | None = getattr(element, "content", None)
        if content is None:
            path = getattr(element, "path", None)
            if not path:
                continue
            content = await asyncio.to_thread(Path(path).read_bytes)
        name = getattr(element, "name", None) or "upload"
        mime = getattr(element, "mime", None) or "application/octet-stream"
        uploads.append((str(name), bytes(content), str(mime)))
    return uploads


@cl.on_message
async def on_message(message: cl.Message) -> None:
    thread_id, _username, _profile, _role = _session_values()
    async with SessionFactory() as session:
        binding = await get_binding(session, thread_id)
        if binding is None:
            await cl.Message(content="会话尚未绑定编排版本，请新建会话后重试。").send()
            return
        objects: tuple[dict, ...] = ()
        uploads = await _read_uploads(message)
        if uploads:
            try:
                objects = await bridge.upload_files(session, binding, uploads)
            except (LookupError, RuntimeError) as error:
                await cl.Message(content=f"文件上传失败：{error}").send()
                return
        await bridge.handle(session, binding, message.content, message.id, objects)


@cl.action_callback("coze_follow_up")
async def on_follow_up(action: cl.Action) -> None:
    """Treat a clicked follow-up suggestion as a new user turn."""
    question = str((action.payload or {}).get("question", "")).strip()
    await action.remove()
    if not question:
        return
    thread_id, _username, _profile, _role = _session_values()
    async with SessionFactory() as session:
        binding = await get_binding(session, thread_id)
        if binding is None:
            await cl.Message(content="会话尚未绑定编排版本，请新建会话后重试。").send()
            return
        await cl.Message(content=question, author="user").send()
        await bridge.handle(session, binding, question, str(uuid4()))


@cl.on_stop
async def on_stop() -> None:
    thread_id, _username, _profile, _role = _session_values()
    await bridge.cancel(thread_id)


@cl.on_chat_end
async def on_chat_end() -> None:
    await on_stop()
