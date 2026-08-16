<div align="center">

# LingxiNext

**Application delivery and operations layer for LingxiGraph.**

Configure, validate, release, and operate controlled multi-agent applications with Chainlit, PostgreSQL, and versioned orchestration.

[简体中文](docs/README.zh-CN.md) · [LingxiGraph](https://github.com/LingXi-Org/LingxiGraph) · [LingXi Organization](https://github.com/LingXi-Org)

</div>

## About

LingxiNext turns LingxiGraph execution capabilities into a deployable application surface.

It provides the controls around the runtime: configuration, validation, immutable revisions, session binding, persistence, administration, and operational visibility.

```text
Operator
   │
   ▼
LingxiNext
Admin · Release · Sessions · Audit
   │
   ▼
LingxiGraph
   │
   ├── Coze / Models / Tools
   └── PostgreSQL
```

## Core capabilities

- **Chainlit application** — learner/user-facing multi-agent conversation surface.
- **Admin console** — manage connections, Agents, orchestrations, revisions, users, and sessions.
- **Versioned orchestration** — validate and publish immutable revisions.
- **Session binding** — keep an existing conversation pinned to the revision it started with.
- **LingxiGraph runtime** — embedded stateful graph execution, checkpoints, recovery, and streaming events.
- **Operational baseline** — PostgreSQL persistence, migrations, health checks, audit records, and Docker Compose deployment.

## Application model

```text
Configure → Validate → Release → Execute → Observe
```

An administrator creates connections and Agent definitions, assembles an approved orchestration, validates it, and publishes a revision. New conversations bind to the active revision while existing sessions remain reproducible.

## Quick start

Requires Docker Engine and Docker Compose v2.

```bash
git clone --recurse-submodules https://github.com/LingXi-Org/LingxiNext.git
cd LingxiNext
cp .env.example .env
```

Configure at least:

```text
CHAINLIT_AUTH_SECRET
LINGXI_MASTER_KEY
POSTGRES_PASSWORD
```

Then start the stack:

```bash
docker compose up --build -d
docker compose ps
```

Default endpoints:

- App: `http://localhost:8123`
- Admin: `http://localhost:8123/admin`
- Health: `http://localhost:8123/health/ready`

## Local development

```bash
git submodule update --init --recursive
uv sync --extra dev
uv run python -m app.migrations
uv run uvicorn app.main:app --reload
```

Quality checks:

```bash
uv run ruff check app scripts tests
uv run mypy app
uv run pytest -q
```

## Repository structure

```text
app/                application, admin, bridge, models, migrations
scripts/            upstream sync and maintenance tools
tests/              runtime, security, and API contract tests
vendor/LingxiGraph/ pinned LingxiGraph submodule
```

## Security

Do not commit `.env` files, real Service Tokens, master keys, or production database backups. Administrative writes require an authenticated administrator session and CSRF protection.

See the organization-wide [security policy](https://github.com/LingXi-Org/.github/blob/main/SECURITY.md).

## License

See [LICENSE](LICENSE).
