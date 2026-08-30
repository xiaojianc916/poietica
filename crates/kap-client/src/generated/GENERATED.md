# generated/

由 `tools/contract/generate-kap.ts` 从 `contracts/kap/{openapi,asyncapi}.json`
生成（`bun run kap:generate`）。**禁手改**：协议演进走快照刷新
（`bun run kap:spec`）再生成，漂移由 CI 的 diff 门禁守住。

- `events.rs` — WS 控制帧与 ack 载荷（asyncapi.json）。会话事件的载荷目前
  原样穿过：它的收口在 translate 层把 wire 事件裁成 ConversationEvent 那一批。
- `rest.rs` — 客户端会走的 REST 路由的请求与应答 data（openapi.json），
  加上各分支共用的 `RestEnvelope`。
