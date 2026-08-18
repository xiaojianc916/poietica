# kap 契约

服务接口由 kap-server 通过 `GET /openapi.json` 和 `GET /asyncapi.json` 自述。

运行 `pnpm kap:spec` 将当前契约快照到本目录（需要 `kimi web` 处于运行状态）。
快照后提交 `openapi.json` 与 `asyncapi.json`，作为 Rust 客户端类型生成的来源。
