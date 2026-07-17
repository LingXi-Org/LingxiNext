from __future__ import annotations

import chainlit as cl
from chainlit.data.sql_alchemy import SQLAlchemyDataLayer
from sqlalchemy import select

from app.bridge import bridge
from app.config import get_settings
from app.db import SessionFactory
from app.models import Orchestration, PlatformUser, ThreadBinding
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
    del user
    async with SessionFactory() as session:
        rows = (
            await session.scalars(
                select(Orchestration)
                .where(
                    Orchestration.enabled.is_(True),
                    Orchestration.active_revision_id.is_not(None),
                )
                .order_by(Orchestration.name)
            )
        ).all()
        return [
            cl.ChatProfile(name=item.slug, markdown_description=item.description or item.name)
            for item in rows
        ]


def _session_values() -> tuple[str, str, str | None]:
    chainlit_session = cl.context.session
    user = getattr(chainlit_session, "user", None)
    return (
        str(chainlit_session.thread_id),
        str(getattr(user, "identifier", "anonymous")),
        getattr(chainlit_session, "chat_profile", None),
    )


@cl.on_chat_start
async def on_chat_start() -> None:
    thread_id, username, profile = _session_values()
    async with SessionFactory() as session:
        if await get_binding(session, thread_id):
            return
        query = select(Orchestration).where(
            Orchestration.enabled.is_(True), Orchestration.active_revision_id.is_not(None)
        )
        if profile:
            query = query.where(Orchestration.slug == profile)
        query = query.order_by(Orchestration.name)
        orchestration = await session.scalar(query)
        if orchestration is None or orchestration.active_revision_id is None:
            await cl.Message(
                content="当前没有已发布的编排方案，请联系管理员在 /admin 中发布。"
            ).send()
            return
        session.add(
            ThreadBinding(
                thread_id=thread_id,
                orchestration_id=orchestration.id,
                revision_id=orchestration.active_revision_id,
                username=username,
            )
        )
        await session.commit()
        cl.user_session.set("orchestration_revision_id", str(orchestration.active_revision_id))
        await cl.Message(content=f"已固定到 **{orchestration.name}** 的当前发布版本。").send()


@cl.on_chat_resume
async def on_chat_resume(_thread) -> None:
    thread_id, _username, _profile = _session_values()
    async with SessionFactory() as session:
        binding = await get_binding(session, thread_id)
        if binding:
            cl.user_session.set("orchestration_revision_id", str(binding.revision_id))


@cl.on_message
async def on_message(message: cl.Message) -> None:
    thread_id, _username, _profile = _session_values()
    async with SessionFactory() as session:
        binding = await get_binding(session, thread_id)
        if binding is None:
            await cl.Message(content="会话尚未绑定编排版本，请新建会话后重试。").send()
            return
        await bridge.handle(session, binding, message.content, message.id)


@cl.on_stop
async def on_stop() -> None:
    thread_id, _username, _profile = _session_values()
    await bridge.cancel(thread_id)


@cl.on_chat_end
async def on_chat_end() -> None:
    await on_stop()
