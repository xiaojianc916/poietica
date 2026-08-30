# kap 契约

kap-server 对自己的接口自述为两份 JSON，本目录是它们的钉定快照。定位 server、
取 token、下载与校验都由 `tools/contract/kap-spec-sync.ts` 完成（需要 `kimi web`
处于运行状态）。

| 文件 | 内容 |
| --- | --- |
| `openapi.json` | REST 面快照（`GET /openapi.json`） |
| `asyncapi.json` | 事件面快照（`GET /asyncapi.json`） |
| `capabilities.json` | 能力集矩阵：REST `/meta` 与 WS `server_hello` 各自声明的能力名，钉在快照的 `server_version` 上。升级审 diff 先看这一页 |
| `checksums.json` | 两份快照全文的 sha256 指纹，守「快照只经 `bun run kap:spec` 改动」 |

后两份从快照文本机器派生，与快照同一次 `kap:spec` 落盘；四份全部禁手改。

升级 kimi-code 后（AGENTS.md §7 协议升级路线）：

```bash
bun run kap:spec           # 刷新快照与派生物
bun run kap:generate       # 重生成 crates/kap-client/src/generated
bun run check              # 全链路验收（含 kap:generated:check 漂移门禁）
```

`bun run kap:spec:check` 先离线核对派生物与快照一致，再与活着的 server 对照。
快照的消费方是 `tools/contract/generate-kap.ts`：Rust 协议模型的唯一产地。
