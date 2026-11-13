# ADR-011：Outbox、幂等与持久工作流

状态：已实施（P6）：outbox / 幂等 / jobs / workflows / 分发器 / 启动续跑；启动对账按六步逐步补齐。

背景：跨模块一致性依赖进程内易失事件，崩溃即丢；Saga 只活在内存里。

决策：

- 业务写入与 `kernel_outbox` 记录同一事务提交；分发器至少一次投递，消费者用幂等键去重。
- 外部副作用（创建 PR、webhook）必须带幂等键，写 `kernel_idempotency`。
- 多步骤流程落 `kernel_workflows`，每步完成即持久化；重启后扫描未完成流程继续。
- 启动对账：中断 Run、过期租约、孤儿 worktree、未确认 outbox、未完成流程、Journal 分段完整性。

后果：

- 进程内事件只用于通知型、可丢的刷新；跨模块事实必须走 outbox。
- 迁移期间两套机制并存，需防止同一副作用被发两次。
