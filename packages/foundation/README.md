# @poietica/foundation

基础层（L0）：不依赖其它 workspace 包的通用原语。

## 内容

- 错误：`AppError`、`SystemErrorCode`、`invariant`、`assertNever`
- 并发：`Deferred`、`withTimeout`、`Batcher`、可注入的 `Clock`
- 事件与资源：`Emitter`、`DisposableStore`；监听器异常经 `lastResort` 隔离
- 结构与标识：单调 ULID、`LineSplitter`、`sortModules`、服务令牌与注册表
- 日志接口 `Logger`、`noopLogger`；实现位于 `@poietica/logging`

层级见 [架构文档 §3](../../docs/ARCHITECTURE.md#3-分层与依赖规则)。
