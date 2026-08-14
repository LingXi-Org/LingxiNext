# LingxiNext

<div align="center">
  <p><strong>Application delivery and operations layer in the LingXi series</strong></p>
  <p><a href="docs/README.zh-CN.md">简体中文</a></p>
</div>

LingxiNext combines the Chainlit interface, an administrative console, revisioned orchestration, and PostgreSQL persistence around an embedded LingxiGraph runtime. It provides a deployable application surface for configuring, validating, releasing, and running controlled multi-agent conversations.

The project focuses on the boundary between a graph runtime and application delivery: configuration, validation, release management, session binding, persistence, and operational visibility.

## Position in the LingXi series

LingxiNext sits above LingxiGraph and turns graph execution capabilities into an application that can be configured and operated as a complete deployment.

~~~mermaid
flowchart TB
    Operator["Operator"] --> Console["LingxiNext admin console"]
    Console --> Release["Validation and revision release"]
    Runtime["LingxiNext application"] --> Bridge["Chainlit–LingxiGraph bridge"]
    Bridge --> Graph["Embedded LingxiGraph runtime"]
    Release --> Graph
    Graph --> Coze["Coze Bot / Coze Workflow"]
    Console --> PostgreSQL[("PostgreSQL")]
    Graph --> PostgreSQL
~~~

| Layer | Responsibility |
| --- | --- |
| **LingxiGraph** | Stateful graph execution, checkpoints, recovery, streaming events, and Agent/Workflow nodes. |
| **LingxiNext** | Application entry point, administrative configuration, orchestration release, thread binding, audit, and deployment baseline. |
| **Coze** | First-class external Agent and Workflow integration in the current release. |

LingxiNext is not a replacement for LingxiGraph. It is the application layer that provides the controls and persistence required to put selected graph definitions into operation.

## Application model

The application follows a configuration–validation–release–execution model:

1. An administrator creates Coze connections and Agent definitions in <code>/admin</code>.
2. An orchestration is assembled from a bounded graph template with explicit roles, edges, and execution limits.
3. The server validates the graph structure and generates an immutable revision.
4. An enabled orchestration appears as a Chainlit Chat Profile at <code>/</code>.
5. Each new thread is bound to the revision active at creation time.
6. Administrative views expose revision information, sessions, runtime state, and audit records.

A later release does not change the revision bound to an existing thread. Historical revisions can be restored into a draft for further validation and release.

## Capabilities

| Capability | Description |
| --- | --- |
| Chainlit integration | Uses the stock Chainlit interface for authentication, Chat Profiles, streaming messages, thread persistence, and follow-up actions. |
| Embedded LingxiGraph | Runs FastAPI, Chainlit, the administrative console, and the graph runtime in one application process. |
| Revisioned orchestration | Publishes immutable revisions and keeps thread execution pinned to a specific revision. |
| PostgreSQL persistence | Stores application data, Chainlit data, thread bindings, checkpoints, and audit records. |
| Coze integration | Supports Coze Bot and Coze Workflow nodes, including protected Service Token handling. |
| Administrative console | Manages connections, Agents, orchestrations, users, sessions, revisions, and audit records. |
| Operational baseline | Includes migrations, liveness/readiness probes, graceful termination, and a Compose deployment. |

## Safe orchestration templates

| Template | Description |
| --- | --- |
| <code>topic_auction</code> | Routes by keyword, topic, difficulty, and continuity. |
| <code>supervisor</code> | Uses a Supervisor to coordinate specialist nodes. |
| <code>handoff</code> | Transfers work along administrator-approved peer edges. |
| <code>parallel_review</code> | Distributes work to reviewers and aggregates it through a judge. |
| <code>plan_execute</code> | Constrains a planner–executor–replanner loop. |

The server validates node roles, Agent types, allowed edges, required topology, reachability, cycles, and execution limits. Graph definitions cannot be created by uploading Python or arbitrary callables through the administrative interface.

## Runtime and persistence

FastAPI registers <code>/admin</code>, <code>/api/admin/*</code>, and <code>/health/*</code> before mounting the official Chainlit application with <code>mount_chainlit(..., path="/")</code>. This keeps host routes ahead of Chainlit's SPA catch-all.

The Chainlit thread ID maps to the graph <code>thread_id</code>. The revision ID is used as the checkpoint namespace, so graph state and application conversations remain associated with the same released definition.

~~~mermaid
flowchart LR
    Browser["Browser"] --> Host["FastAPI host"]
    Host --> Admin["Admin UI and API"]
    Host --> Chainlit["Stock Chainlit UI"]
    Chainlit --> Bridge["Chainlit–LingxiGraph bridge"]
    Bridge --> Runtime["Embedded LingxiGraph runtime"]
    Runtime --> Coze["Coze Chat / Workflow"]
    Admin --> PostgreSQL[("PostgreSQL")]
    Chainlit --> PostgreSQL
    Runtime --> PostgreSQL
~~~

## Security and operational baseline

- **Authentication and access**: Chainlit password authentication; administrative write APIs require an administrator session and CSRF token.
- **Credential protection**: Coze Service Tokens are encrypted with a deployment-level master key and returned as masked values.
- **Auditability**: Key administrative actions and session views are written to audit records.
- **Container posture**: The application runs as a non-root user with a read-only root filesystem, <code>no-new-privileges</code>, and restricted <code>tmpfs</code> paths.
- **Startup and shutdown**: Compose starts migrations before the application, checks PostgreSQL readiness, and allows graceful termination.
- **Data handling**: <code>.env</code> files, real Service Tokens, and production database backups must not be committed.

These controls describe the baseline included in this repository. Single sign-on, network policy, backups, monitoring, retention, incident response, and compliance controls remain deployment concerns.

<details>
<summary>Current scope</summary>

- The current MVP is single-tenant and has no public sign-up; platform users are managed by administrators.
- Coze Bot and Coze Workflow are the supported external Agent capabilities in this release.
- This release is not a general-purpose multi-tenant control plane. Tenant isolation, billing, public sign-up, and related capabilities require additional product work.

</details>

## Quick start

### Docker Compose

Requires Docker Engine and Docker Compose v2.

~~~bash
git clone --recurse-submodules https://github.com/LingXi-Org/LingxiNext.git
cd LingxiNext
cp .env.example .env
~~~

Replace every placeholder in <code>.env</code> with an independent strong random value, including at least:

- <code>CHAINLIT_AUTH_SECRET</code>
- <code>LINGXI_MASTER_KEY</code>
- <code>POSTGRES_PASSWORD</code>

~~~bash
docker compose up --build -d
docker compose ps
~~~

Default endpoints:

- Chainlit: <http://localhost:8123>
- Administration: <http://localhost:8123/admin>
- Liveness: <http://localhost:8123/health/live>
- Readiness: <http://localhost:8123/health/ready>

The first startup idempotently creates the administrator configured in <code>.env</code>. After signing in, create a Coze connection, Agents, and an orchestration; validate and publish a revision. Enabled orchestrations appear as Chainlit Chat Profiles.

### Local development

The project uses [uv](https://docs.astral.sh/uv/) for dependency and lock-file management.

~~~bash
git submodule update --init --recursive
uv sync --extra dev
uv run python -m app.migrations
uv run uvicorn app.main:app --reload
~~~

Quality checks:

~~~bash
uv run ruff check app scripts tests
uv run ruff format --check app scripts tests
uv run mypy app
uv run pytest -q
docker build -t lingxinext:local .
~~~

## Project structure

~~~text
app/
  admin.py             Admin UI, API, and health checks
  bridge.py            Chainlit–LingxiGraph runtime bridge
  chat.py              Chainlit auth, data layer, and Chat Profiles
  graph_templates.py   Safe template validation and compiler
  migrations.py        Database initialization
  models.py            PostgreSQL models
scripts/
  sync_upstreams.py    Upstream sync and compatibility checks
tests/                  Security, template, and API contract tests
vendor/LingxiGraph/    Pinned upstream Git submodule
~~~

## Upstream synchronization and version governance

<code>vendor/LingxiGraph</code> tracks the upstream <code>main</code> branch as a Git submodule, while the parent repository records an exact submodule commit. Chainlit is pinned to a contract-tested stable version.

~~~bash
python scripts/sync_upstreams.py --check
python scripts/sync_upstreams.py --apply
~~~

<code>--apply</code> updates the LingxiGraph submodule pointer, resolves a stable Chainlit version, refreshes <code>uv.lock</code>, and runs formatting, typing, unit, contract, and Docker build checks. It does not commit, push, or create a pull request.

## Documentation and related projects

- [LingxiGraph](https://github.com/LingXi-Org/LingxiGraph): the underlying multi-agent graph runtime.
- [Architecture and execution semantics](vendor/LingxiGraph/docs/architecture.md)
- [Agents, tools, and multi-agent patterns](vendor/LingxiGraph/docs/agents.md)
- [Coze integration](vendor/LingxiGraph/docs/integrations-coze.md)
- [Production operations](vendor/LingxiGraph/docs/operations.md)
- [Security and tenancy design](vendor/LingxiGraph/docs/security.md)

## Contributing and security

Issues, design discussions, documentation improvements, and pull requests are welcome. Before contributing, read the organization-wide [contribution guide](https://github.com/LingXi-Org/.github/blob/main/CONTRIBUTING.md) and review existing issues.

Report security issues privately according to the organization's [security policy](https://github.com/LingXi-Org/.github/blob/main/SECURITY.md). Never commit <code>.env</code> files, real Service Tokens, or production database backups.

When updating LingxiGraph or Chainlit, include the lock file, the submodule pointer, and compatibility-test results in the same change.
