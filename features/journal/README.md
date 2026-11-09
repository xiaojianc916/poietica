# @poietica/feature-journal

Thread Journal（ADR-005）：只存 omp 不知道的产品记录，按 `(threadId, agentId, seq)` 追加 committed AgentEvent。

- 表：`journal_events`（SQLite，与领域状态同库同事务）。
- 服务：`core-api` 的 `JournalServiceToken`，提供 `append` / `appendAndStamp` / `read` / `latestSeq` / `clear`。
- 当前写入点在 conversation 的 EventRouter，广播前先落库；读取仍走 omp 会话文件投影，Journal 驱动的快照与重建属于 P2 后续。
