# @poietica/stream-kit

通用流原语（ADR-006）：`StreamChannel<T>` 提供快照位置、epoch/seq 编号、16ms 合批、环形缓冲、补发与批内合并。

时间线、终端、浏览器标签最终共用这一套；当前 conversation 的 `TimelineChannel` 已接入，Host 的主题路由按 `(threadId, agentId)` 只发订阅窗口。
