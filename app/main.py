from __future__ import annotations

import logging
import os
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

from .bridge import graph_manager
from .config import get_settings
from .db import SessionFactory
from .migrations import migrate
from .repository import bootstrap_admin

settings = get_settings()
os.environ.setdefault("CHAINLIT_AUTH_SECRET", settings.chainlit_auth_secret.get_secret_value())
logging.basicConfig(level=getattr(logging, settings.lingxi_log_level.upper(), logging.INFO))


@asynccontextmanager
async def lifespan(_app: FastAPI):
    await migrate()
    async with SessionFactory() as session:
        await bootstrap_admin(
            session,
            settings.lingxi_admin_username,
            settings.lingxi_admin_password.get_secret_value(),
        )
    yield
    await graph_manager.invalidate()


app = FastAPI(title="LingxiNext", version="0.1.0", lifespan=lifespan)
app.mount(
    "/admin-static", StaticFiles(directory=Path(__file__).parent / "static"), name="admin-static"
)

from .admin import router as admin_router  # noqa: E402

app.include_router(admin_router)

# Mount last: parent routes keep precedence over Chainlit's SPA catch-all.
from chainlit.utils import mount_chainlit  # noqa: E402

mount_chainlit(app=app, target=str(Path(__file__).with_name("chat.py")), path="/")
