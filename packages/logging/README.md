# @poietica/logging

结构化日志（L2）：记录器、可插拔 sink、脱敏与 JSONL 文件落盘。

## 关键导出

- `createLogger`：级别过滤、`child` 绑定与多 sink
- Sink：`stderrJsonSink`、开发用 `consoleSink`、按大小轮转的 `jsonlFileSink`
- `redactSecrets`：按敏感键名脱敏，处理循环引用与超长字符串

## 约束

Sink 的 `write` 不得抛错，并负责脱敏；Host 与 Core 各写自己的日志文件。

数据归属见 [架构文档 §7](../../docs/ARCHITECTURE.md#7-数据与存储)。
