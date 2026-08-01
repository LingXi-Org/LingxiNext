# LingxiNext 运行链路基线

LingxiNext 将 FastAPI、原生 Chainlit 和嵌入式 LingxiGraph 放在同一进程中。管理端只负责维护受约束的编排草稿并发布不可变 revision，聊天端不会执行未发布草稿。

一条新消息的完整链路如下：

```text
Chainlit on_message
  → 读取 ThreadBinding
  → bridge.handle()
  → GraphManager 按 revision digest 获取或编译图
  → GraphCompiler 校验安全模板、Agent 类型与拓扑
  → CompiledGraph.astream_events()
  → Coze Chat / Workflow
  → Chainlit 增量消息与步骤
  → PostgreSQL Checkpoint
```

新会话在 `on_chat_start` 中将 Chainlit thread ID 绑定到编排的当前 active revision。运行配置使用：

- `thread_id`：Chainlit thread ID；
- `checkpoint_ns`：不可变 revision ID；
- `username`：当前平台用户名；
- event streaming 与 cancellation token：用于流式输出和停止运行。

恢复会话时只读取原 `ThreadBinding.revision_id`，不会切换到后来发布的版本。因此，修改草稿或发布新 revision 都不会改变历史会话的图和 checkpoint 命名空间。

教育角色访问控制发生在新会话绑定之前：Chat Profile 展示时先过滤一次，`on_chat_start` 再按 active revision 的 `audience_roles` 校验一次。已经绑定的历史会话继续使用原 revision。
