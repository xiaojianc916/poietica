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

## 实施进度（2026-11-15）

- 工作区删除已经改成持久事实：`workspaces.remove` 在删行的同一事务里写 `kernel_outbox`（topic `workspaces.removed`，幂等键为工作区 id），内存事件只负责让 UI 立刻刷新。
- conversation / automations / files / review 各自注册 outbox handler；进程在「删行」与「级联清理」之间退出时，下次启动由分发器补投。
- 线程删除同样进入 outbox（topic `conversation.threadRemoved`）：删行事务内入队，automations / review / intelligent-ui 改由 handler 清账；原来的进程内 `threadRemoved` 事件已无消费者并删除。
- 同一 topic 现在支持多个消费者：注册表按 topic 收一组 handler，分发器按注册顺序串行调用，全部成功才把记录标记完成；失败则整条记录按退避重试。
- 启动对账第 5 步已接上：模块可注册 `jobHandlers` / `workflowHandlers`，内核在 `core.ready` 前续跑未完成 workflow，并启动持久 job 分发器（只读模式跳过）。
- 测试 harness 默认关闭 outbox 定时器（`outboxDispatch: false`），避免假时钟推进 25 小时时定时器空转；测 outbox 的用例显式打开。
- 启动对账第 1 步已接上：conversation 在 onReady 扫描每条线程的 `run.started` / `run.completed`，只有开始没有终态的补 `run.completed { outcome: 'interrupted' }`；Journal 新增按类型读取的 `readTyped`，重复启动不会重复补。
- 写租约是内存态：Core 重启后旧租约自然消失，因此没有「启动时释放过期租约」这一步；运行中的 Worker 崩溃由事件路由收口并释放。
- 本次收口「工作区/线程删除」「中断 Run」「jobs/workflows 续跑」「孤儿 worktree 回收」；Journal 目前是单表、按线程检查 seq 连续性，启动时发现 gap 只记 warn，分段重建仍未做。

## 实施进度（2026-11-15 续）

- Journal 已从单表升级为「事件 + 分段」：迁移 v2 增加 `journal_segments` 与 `journal_events.segment_id`。段满（默认 1000 条 / 2 MiB）后封段并写 SHA-256 校验和；读取仍按 seq 走同一张事件表。
- 启动对账第 6 步已接上 Journal 部分：`integrity` 除 seq gap 外，还核对每段的起止序号、事件数、字节数与校验和；不符的段标记为 `corrupt` 并保持只读隔离，由 conversation 启动日志告警。
- 时间线索引与 omp 会话文件不一致时的后台重建仍未做（当前时间线索引由 omp 会话回读，没有独立持久索引）。
