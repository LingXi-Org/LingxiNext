from __future__ import annotations

import asyncio

from lingxigraph import PostgresSaver
from sqlalchemy import text

from .config import get_settings
from .db import engine
from .models import Base

CHAINLIT_DDL = """
CREATE TABLE IF NOT EXISTS users (
    "id" TEXT PRIMARY KEY,
    "identifier" TEXT UNIQUE NOT NULL,
    "createdAt" TEXT NOT NULL,
    "metadata" TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS threads (
    "id" TEXT PRIMARY KEY,
    "createdAt" TEXT,
    "name" TEXT,
    "userId" TEXT,
    "userIdentifier" TEXT,
    "tags" TEXT,
    "metadata" TEXT
);
CREATE TABLE IF NOT EXISTS steps (
    "id" TEXT PRIMARY KEY,
    "name" TEXT,
    "type" TEXT,
    "threadId" TEXT,
    "parentId" TEXT,
    "disableFeedback" BOOLEAN,
    "streaming" BOOLEAN,
    "waitForAnswer" BOOLEAN,
    "isError" BOOLEAN,
    "metadata" TEXT,
    "tags" TEXT,
    "input" TEXT,
    "output" TEXT,
    "createdAt" TEXT,
    "start" TEXT,
    "end" TEXT,
    "generation" TEXT,
    "showInput" TEXT,
    "language" TEXT,
    "indent" INTEGER,
    "defaultOpen" BOOLEAN
);
CREATE TABLE IF NOT EXISTS feedbacks (
    "id" TEXT PRIMARY KEY,
    "forId" TEXT,
    "threadId" TEXT,
    "value" DOUBLE PRECISION,
    "comment" TEXT,
    "createdAt" TEXT
);
CREATE TABLE IF NOT EXISTS elements (
    "id" TEXT PRIMARY KEY,
    "threadId" TEXT,
    "forId" TEXT,
    "type" TEXT,
    "url" TEXT,
    "name" TEXT,
    "display" TEXT,
    "objectKey" TEXT,
    "chainlitKey" TEXT,
    "size" BIGINT,
    "page" INTEGER,
    "language" TEXT,
    "mime" TEXT,
    "props" TEXT,
    "createdAt" TEXT
);
CREATE INDEX IF NOT EXISTS idx_threads_user_id ON threads ("userId");
CREATE INDEX IF NOT EXISTS idx_threads_user_identifier ON threads ("userIdentifier");
CREATE INDEX IF NOT EXISTS idx_steps_thread_id ON steps ("threadId");
CREATE INDEX IF NOT EXISTS idx_feedbacks_thread_id ON feedbacks ("threadId");
CREATE INDEX IF NOT EXISTS idx_elements_thread_id ON elements ("threadId");
"""


async def migrate() -> None:
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
        for statement in CHAINLIT_DDL.split(";"):
            if statement.strip():
                await connection.execute(text(statement))

    # LingxiGraph owns its checkpoint schema and setup remains idempotent.
    await asyncio.to_thread(PostgresSaver(get_settings().lingxigraph_postgres_url).setup)


def main() -> None:
    asyncio.run(migrate())


if __name__ == "__main__":
    main()
