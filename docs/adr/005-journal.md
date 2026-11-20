# ADR-005：Thread Journal 与时间线索引

状态：已实施；时间线独立索引重建待做。

- 对话内容的唯一事实来源仍是 omp 会话文件；Thread Journal 只存 omp 不知道的产品记录（运行状态迁移、交互、策略裁决、检查点、用量、中断、提示）。
- 时间线索引是缓存：由 engine-omp 的唯一规范化器重放 omp 会话文件重建；索引损坏或升级时后台重建，不阻塞冷读走即时重放。
- committed AgentEvent 按 `(threadId, seq)` 追加写入 SQLite；`seq` 由 Core 签发，瞬态事件不落库。快照由 `ThreadReducer` 折叠 Journal/索引产生，UI 与 Core 共用同一份 fold。
- 大载荷（工具长输出、图片、文件快照）按内容寻址放 blob，事件只放引用与预览。
- P1 已建立 AgentEvent 与唯一 fold；本 ADR 的持久化与重建在 P2 落地。标题的事实归 omp 会话名，threads 表只留索引。

## 实施进度（2026-11-08）

- 已落地 `features/journal`：`journal_events` 表、服务令牌、`appendAndStamp`；conversation 的 EventRouter 在广播前先把 committed 事件写入 Journal。
- 尚未落地：由 omp 会话文件重建独立时间线索引；当前冷读仍以 Journal 折叠为主、缺页回退会话文件。
- 主对话的冷读优先从 Journal 折叠快照：头页取最近一页并生成轮次目录；往前翻页要求从第 1 轮开始记录且覆盖到请求页，否则回退 omp 会话文件。读取上限 10 万条，最后一条追不上水位时同样回退。
- 旧线程第一次冷读且 Journal 为空时，从 omp 会话文件逐页回填（最多 500 页/约 1 万轮）成 committed 事件（`eventsFromPage`）；拼页由 `pagesToPage` 按轮序还原；回填异步执行，首屏这一次先走会话文件，超过上限的会话留给后续任务。回填后即可脱离会话文件冷读。

- **标题索引**：事实是 omp 会话名；`threads.title`/`title_source` 只是可重建索引。`rename` 先写 omp，`sessionTitle` 事件再回写行；不存在第二个事实来源。
