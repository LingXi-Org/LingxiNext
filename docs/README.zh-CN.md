# LingxiNext · 中文

<div align="center">
  <p><strong>LingXi 系列中的应用交付与运营层</strong></p>
  <p>将图运行时能力整理为可配置、可发布、可维护的应用。</p>
  <p><a href="../README.md">English</a></p>
</div>

LingxiNext 围绕嵌入式 LingxiGraph 运行时，组合 Chainlit 对话界面、管理后台、revision 编排和 PostgreSQL 持久化能力，形成一个可独立部署的应用层。

项目关注图运行时与应用交付之间的边界：配置、校验、发布、会话绑定、持久化和运行状态查看。

## 在 LingXi 系列中的位置

LingxiNext 位于 LingxiGraph 之上，负责将图执行能力整理为可以配置和运营的完整应用。

~~~mermaid
flowchart TB
    Operator["运营管理员"] --> Console["LingxiNext 管理后台"]
    Console --> Release["安全校验与 revision 发布"]
    Runtime["LingxiNext 应用"] --> Bridge["Chainlit–LingxiGraph bridge"]
    Bridge --> Graph["嵌入式 LingxiGraph 运行时"]
    Release --> Graph
    Graph --> Coze["Coze Bot / Coze Workflow"]
    Console --> PostgreSQL[("PostgreSQL")]
    Graph --> PostgreSQL
~~~

| 层级 | 主要职责 |
| --- | --- |
| **LingxiGraph** | 提供有状态图执行、checkpoint、恢复、流式事件，以及 Agent/Workflow 节点能力。 |
| **LingxiNext** | 提供应用入口、管理配置、编排发布、会话绑定、审计和部署运维基线。 |
| **Coze** | 作为当前版本的一等外部 Agent 与 Workflow 集成。 |

LingxiNext 不替代 LingxiGraph，而是提供将选定图定义投入运行所需的控制和持久化能力。

## 应用模型

系统遵循“配置—校验—发布—执行”模型：

1. 管理员在 <code>/admin</code> 创建 Coze 连接和 Agent 定义。
2. 编排方案基于受约束的图模板组装，并明确节点角色、允许边和运行上限。
3. 服务端校验图结构，生成不可变 revision。
4. 已启用的编排方案会在 <code>/</code> 作为 Chainlit Chat Profile 提供。
5. 每个新会话固定到创建时生效的 revision。
6. 管理界面提供 revision、会话、运行状态和审计记录查看能力。

后续发布不会改变已绑定会话的 revision。历史 revision 可以恢复为草稿，继续校验和发布。

## 能力范围

| 能力 | 说明 |
| --- | --- |
| Chainlit 集成 | 使用原生 Chainlit 提供认证、Chat Profile、流式消息、线程持久化和跟进操作。 |
| 嵌入式 LingxiGraph | 在同一应用进程中运行 FastAPI、Chainlit、管理后台和图运行时。 |
| Revision 编排 | 发布不可变 revision，并将会话执行固定到具体版本。 |
| PostgreSQL 持久化 | 保存应用数据、Chainlit 数据、会话绑定、checkpoint 和审计记录。 |
| Coze 集成 | 支持 Coze Bot 与 Coze Workflow 节点，并保护 Service Token。 |
| 管理后台 | 管理连接、Agent、编排、用户、会话、revision 和审计记录。 |
| 运维基线 | 提供迁移、存活/就绪探针、优雅终止和 Compose 部署方式。 |

## 安全编排模板

| 模板 | 说明 |
| --- | --- |
| <code>topic_auction</code> | 按关键词、主题、难度和连续性进行路由。 |
| <code>supervisor</code> | 由 Supervisor 调度 specialist 节点。 |
| <code>handoff</code> | 沿管理员批准的 peer 边转交任务。 |
| <code>parallel_review</code> | 将任务并行分发给 reviewer，再由 judge 汇总。 |
| <code>plan_execute</code> | 约束 planner–executor–replanner 循环。 |

服务端会校验节点角色、Agent 类型、允许边、必需拓扑、入口可达性、循环和运行上限。管理界面不能通过上传 Python 或任意 callable 创建不受约束的图。

## 运行时与持久化

FastAPI 先注册 <code>/admin</code>、<code>/api/admin/*</code> 和 <code>/health/*</code>，最后通过 Chainlit 官方 <code>mount_chainlit(..., path="/")</code> 挂载聊天应用，确保宿主路由优先于 Chainlit 的 SPA catch-all。

Chainlit thread ID 映射到图的 <code>thread_id</code>。revision ID 作为 checkpoint namespace，使图状态和应用会话始终关联到同一发布定义。

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

## 安全与运维基线

- **认证与访问**：使用 Chainlit 密码认证；管理写接口要求管理员会话和 CSRF Token。
- **凭据保护**：Coze Service Token 使用部署级主密钥加密，并以掩码值返回。
- **审计**：关键管理操作和会话查看会写入审计记录。
- **容器基线**：应用以非 root 用户、只读根文件系统、<code>no-new-privileges</code> 和受限 <code>tmpfs</code> 路径运行。
- **启动与退出**：Compose 在应用启动前执行迁移，检查 PostgreSQL 就绪状态，并支持优雅终止。
- **数据处理**：<code>.env</code>、真实 Service Token 和生产数据库备份不得提交。

以上内容是仓库提供的基础能力。单点登录、网络策略、备份、监控、事件响应、数据保留和合规控制仍由部署环境负责。

<details>
<summary>当前范围</summary>

- 当前 MVP 为单租户、无公开注册，平台用户由管理员管理。
- 当前版本支持 Coze Bot 与 Coze Workflow 两类外部 Agent 能力。
- 当前版本不是通用多租户控制面；租户隔离、计费、公开注册等能力需要额外开发。

</details>

## 快速开始

### Docker Compose

要求 Docker Engine 与 Docker Compose v2。

~~~bash
git clone --recurse-submodules https://github.com/LingXi-Org/LingxiNext.git
cd LingxiNext
cp .env.example .env
~~~

将 <code>.env</code> 中的所有占位值替换为相互独立的强随机值，至少包括：

- <code>CHAINLIT_AUTH_SECRET</code>
- <code>LINGXI_MASTER_KEY</code>
- <code>POSTGRES_PASSWORD</code>

~~~bash
docker compose up --build -d
docker compose ps
~~~

默认入口：

- Chainlit：<http://localhost:8123>
- 管理后台：<http://localhost:8123/admin>
- 存活探针：<http://localhost:8123/health/live>
- 就绪探针：<http://localhost:8123/health/ready>

首次启动会幂等创建 <code>.env</code> 中配置的管理员。登录后创建 Coze 连接、Agent 和编排方案，完成校验并发布 revision；已启用的编排方案会显示为 Chainlit Chat Profile。

### 本地开发

项目使用 [uv](https://docs.astral.sh/uv/) 管理依赖与锁文件。

~~~bash
git submodule update --init --recursive
uv sync --extra dev
uv run python -m app.migrations
uv run uvicorn app.main:app --reload
~~~

质量检查：

~~~bash
uv run ruff check app scripts tests
uv run ruff format --check app scripts tests
uv run mypy app
uv run pytest -q
docker build -t lingxinext:local .
~~~

## 项目结构

~~~text
app/
  admin.py             管理页面、管理 API 与健康检查
  bridge.py            Chainlit 与 LingxiGraph 运行桥接
  chat.py              Chainlit 认证、数据层与 Chat Profile
  graph_templates.py   安全模板校验与编译器
  migrations.py        数据库初始化
  models.py            PostgreSQL 数据模型
scripts/
  sync_upstreams.py    上游同步与兼容性验证
tests/                  安全、模板和 API 契约测试
vendor/LingxiGraph/    固定 commit 的上游 Git 子模块
~~~

## 上游同步与版本治理

<code>vendor/LingxiGraph</code> 跟踪上游 <code>main</code> 分支，父仓库记录确定的子模块 commit。Chainlit 锁定在经过契约测试的稳定版本。

~~~bash
python scripts/sync_upstreams.py --check
python scripts/sync_upstreams.py --apply
~~~

<code>--apply</code> 会更新 LingxiGraph 子模块指针、解析 Chainlit 稳定版本、刷新 <code>uv.lock</code>，并运行格式、类型、单元、契约和 Docker 构建检查；脚本不会提交、推送或创建 Pull Request。

## 文档与相关项目

- [LingxiGraph](https://github.com/LingXi-Org/LingxiGraph)：底层多智能体图运行时。
- [架构与执行语义](../vendor/LingxiGraph/docs/architecture.md)
- [Agent、工具与多智能体模式](../vendor/LingxiGraph/docs/agents.md)
- [Coze 集成](../vendor/LingxiGraph/docs/integrations-coze.md)
- [生产运维手册](../vendor/LingxiGraph/docs/operations.md)
- [安全与租户设计](../vendor/LingxiGraph/docs/security.md)

## 贡献与安全

欢迎提交问题报告、设计讨论、文档改进和 Pull Request。开始前请阅读组织级[贡献指南](https://github.com/LingXi-Org/.github/blob/main/CONTRIBUTING.md)和本仓库现有 Issue。

安全问题请遵循组织级[安全策略](https://github.com/LingXi-Org/.github/blob/main/SECURITY.md)私下报告。请勿将 <code>.env</code>、真实 Service Token 或生产数据库备份提交到仓库。

更新 LingxiGraph 或 Chainlit 时，请同时提交锁文件、子模块指针和兼容性测试结果。
