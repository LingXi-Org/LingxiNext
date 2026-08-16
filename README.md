<div align="center">

# LingxiNext

**Safe, versioned multi-agent application layer for LingxiGraph.**

Turn controlled LingxiGraph orchestrations into deployable Chainlit applications with validation, immutable revisions, session binding, persistence, and auditability.

[简体中文](docs/README.zh-CN.md) · [LingxiGraph](https://github.com/LingXi-Org/LingxiGraph) · [LingXi Organization](https://github.com/LingXi-Org)

</div>

## About

LingxiNext is an application layer built on top of LingxiGraph. It combines a Chainlit conversation surface, a FastAPI administration layer, controlled graph templates, PostgreSQL persistence, and an embedded LingxiGraph runtime in one deployable service.

Its core model is deliberately constrained:

```text
Configure → Validate → Publish Revision → Bind Session → Execute → Observe
```

Administrators configure external Agent connections and orchestration drafts. The server validates those drafts against approved graph templates before publishing immutable revisions. New conversations bind to the active revision, while existing conversations continue on the revision they started with.

```text
User / Operator
      │
      ▼
   LingxiNext
Chainlit · Admin · Revisions · Sessions · Audit
      │
      ▼
   LingxiGraph
      │
      ├── Coze Chat / Workflow
      └── PostgreSQL Checkpoints
```

## Current capabilities

- **Chainlit application** — authentication, chat profiles, streaming responses, file uploads, follow-up actions, and conversation threads.
- **Administration layer** — manage platform users, Coze connections, Agent definitions, orchestrations, revisions, sessions, and audit records.
- **Controlled orchestration** — graph drafts are validated against predefined roles, edges, topology rules, and execution limits before release.
- **Immutable revisions** — every published orchestration becomes a versioned revision with a digest and publisher record.
- **Session binding** — each thread remains pinned to its original revision so later releases do not silently change existing conversations.
- **Embedded LingxiGraph runtime** — stateful graph execution, streaming events, cancellation, checkpoints, and recovery run inside the application.
- **PostgreSQL persistence** — application data, thread bindings, checkpoints, and audit records share a production-oriented persistence layer.
- **Operational baseline** — migrations, health probes, graceful shutdown, read-only containers, and Docker Compose deployment.

## Controlled graph templates

The current runtime exposes five approved orchestration patterns:

| Template | Purpose |
| --- | --- |
| `topic_auction` | Route between Agents using constrained topic/priority signals. |
| `supervisor` | Let one supervisor coordinate specialist nodes. |
| `handoff` | Transfer work only across administrator-approved peer edges. |
| `parallel_review` | Fan out to reviewers and aggregate with a judge. |
| `plan_execute` | Run a constrained planner → executor → replanner loop. |

The administration surface cannot upload arbitrary Python callables or bypass these server-side validation rules.

## Current integrations and scope

LingxiNext currently supports **Coze Chat Agents** and **Coze Workflows** as first-class external Agent capabilities. Service tokens are stored encrypted and are never returned in plaintext by the administration API.

The current project is a **single-tenant application baseline** with administrator-managed users and no public registration. It is not a general multi-tenant control plane, billing platform, or identity provider.

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

Start the stack:

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
uv run ruff format --check app scripts tests
uv run mypy app
uv run pytest -q
```

## Repository structure

```text
app/
  admin.py             administration UI, API, and health endpoints
  bridge.py            Chainlit ↔ LingxiGraph runtime bridge
  chat.py              Chainlit authentication and chat lifecycle
  graph_templates.py   controlled templates, validation, and compilation
  migrations.py        database initialization and migrations
  models.py            PostgreSQL application models
scripts/                upstream synchronization and maintenance
tests/                  runtime, security, template, and API contract tests
vendor/LingxiGraph/     pinned LingxiGraph submodule
```

## Security

Administrative writes require an authenticated administrator session and CSRF protection. Coze service tokens are encrypted with the deployment master key. The container baseline uses a non-root user, read-only filesystem, `no-new-privileges`, and restricted temporary filesystems.

Do not commit `.env` files, real service tokens, master keys, or production database backups.

See the organization-wide [security policy](https://github.com/LingXi-Org/.github/blob/main/SECURITY.md).

## License

See [LICENSE](LICENSE).
