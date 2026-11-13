# @poietica/feature-timeline

时间线增量通道（P6c）：每 `(threadId, agentId)` 一条内存通道，epoch 跨进程不重复，支持增量补发与重置。

- 契约：`timeline.events` / `timeline.reset` 两条通知。
- 服务：`TimelineServiceToken`；conversation 的 `timeline.*` 方法通过它读取通道。
- 历史页仍由 conversation 的 Journal/会话文件读取提供；本模块目前只管增量广播。
