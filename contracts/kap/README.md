# kap 契约

服务接口由 kap-server 通过 `GET /openapi.json` 和 `GET /asyncapi.json` 自述。

运行 `bun run kap:spec` 将当前契约快照到本目录（需要 `kimi web` 处于运行状态）。
快照后提交 `openapi.json` 与 `asyncapi.json`：它们是可审查的协议漂移基线，不是
已经生成的客户端 —— 当前 Rust driver 仍显式解析 kap JSON，所以本目录不得被写成
Rust 类型生成的来源。
