# @poietica/transcript

时间线领域模型（三个进程共用）：引擎侧投影器产出 op、主进程 `event-router` 盖章、渲染进程 `TranscriptReducer` 归约，三处共用同一套类型、同一份 zod schema、同一个 `applyOperation`。

- **这是 Poietica 自有的词表，不是 vendored 依赖。** `src/model`、`src/ops`、`src/contract` 最初分叉自 MoonshotAI/kimi-code 的 `@moonshot-ai/transcript` 0.0.2（tag `@moonshot-ai/kimi-code@0.41.0`，commit `95478e8c7ba248fd2470d5bb151555ec7fedd19d`，MIT 许可，见 LICENSE）。上游不再同步。词表缺什么（如 `clientTurnId`、`plan` 交互）就在这里加，**不要在消费侧用断言或 schema 手术补**。
- 与 lint / typecheck 同等对待：biome 不再排除本目录；线上形状由 `packages/protocol` 的契约快照（`bun run protocol:snapshot`）把关，改 schema 即改协议。
- `src/timeline.ts`：高层 API（`stateFromPage`、`applyOps`、`prependOlder` 等）。分页合并只有 `prependOlder` 一处实现，渲染进程不再自带一份。
