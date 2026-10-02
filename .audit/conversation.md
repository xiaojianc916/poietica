# packages/conversation 审计报告

范围：`packages/conversation/**`。验证命令（全绿）：
`bun run --filter @poietica/conversation test`（437 pass / 0 fail）、
`bun run test:architecture`（架构闸门通过：20 个工作区、16 个 crate）、
`bun run --filter @poietica/conversation typecheck`、`bunx biome check packages/conversation/src/transcript`（0 error / 0 warning）。

测量口径：投影器与 store 是纯 TS，MCP 宿主在 dev 重启后失联，故改用 `bun -e` 直接跑真实模块做
A/B（同一份数据、同一进程、交替计时）。样本：200 条已封口轮（每轮 40 段 × 30 帧，1/3 是工具调用）
+ 1 条正在流式的同类轮；每次 delta 只替换动过的那一段（= 本包上游 reducer 的结构共享行为）。

## 已修复

- `packages/conversation/src/transcript/transcript-projector.ts:1067` —— 目录标记用模块级 `Map<turnId, TurnMark>` 记账：turnId 在每条对话、每个子代理频道里都从 `t1` 重新编，进程级表按它记账会把 A 对话的题面与回复发给 B；`reset` 换掉正文而号不变时同样认错；且只写不删，开过的对话越多久占越大。**证据**：MCP 真宿主实测两条对话各自 `outlineOf` 后 `b[0] === a[0]` 为 `true`（B 拿到 A 的「A 的问题 / A 的回复」）；新增测试 `outline marks belong to the conversation that owns the turn > the same turnId in another conversation never reuses its mark`。**改法**：换成 `WeakMap<TranscriptTurn, { sealed, mark }>`（与同文件 `TURN_PROJECTIONS`:819、`WRAPPED_PAGES`:919 同一形态），记账里带上「算这个 reply 时封口没有」。保留 1131 行引用稳定化；不选「按对话存 + dispose 清」的理由已写进 1055-1066 的注释：turn 对象本就归每条对话持有，WeakMap 既认归属又随之回收，不必再引一条生命周期。

- `packages/conversation/src/transcript/transcript-projector.ts:1080` —— 上一处换成身份键后，流式轮每帧都换新 turn 对象，`reply` 要整轮重拼（实测 0.0212 → 0.1128 ms/次，**回退 5.3×**）。**证据**：同上 A/B；`reply` 拼接按 72000 B/帧线性增长。**改法**：加 `STEP_REPLIES` 逐段 memo（1080-1097），只重拼真正动过的那一段 —— 回到 0.1128 ms 的同时不再整轮重拼。

- `packages/conversation/src/transcript/transcript-projector.ts:800` —— 每次 ops 批到达都整轮重投影：`framesOf` 遍历该轮全部 step，`frameOf` → `ompToolView` 重算工具视图与 `jsonOf` 入参 JSON。**证据**：`bun -e` A/B，200 轮语料下 `projectTranscript` 0.8356 → 0.2508 ms/次（**3.3×**）；条目身份 churn 从「每帧换新 241401 个条目对象」降到 31 个（同一测量：241401 / 31）——React 行 memo 的输入因此才真稳得住。**改法**：`STEP_FRAMES` 按 step 对象身份记账（769-806），判据含 `ordinal` 与兜底时间戳（turn 每帧换、从它读来的那两个数必须一起比过）；新增测试 `step projection is reused while one step streams > untouched steps keep their projected items while the tail step advances`。

- `packages/conversation/src/transcript/transcript-store.ts:910` —— `#requestMedia` 每次发布全量扫 `snapshot.attachments`，而该表是整条会话累积的（每条消息的图都在、永不删），发布却是每帧一次。**证据**：新增测试 `historical media is fetched only for attachments the page references > an unreferenced image is never fetched, a referenced one is fetched once`；把该守卫退回全量扫后此测试立刻变红（已实测，46 pass / 1 fail），确认它测的就是这条改动。**改法**：先按 `turn.attachmentIds` 挑出这一页引用到的附件，再在候选上判 `needsMediaFetch`。

## 仅报告（未改，跨范围或需决策）

- `packages/conversation/src/transcript/transcript-store.ts:838` `#publish` —— 订阅者按频道（`threadId` 或 `delegateKey`）收通知，但每条子代理的帧都会重建该对话主频道的 `Transcript` 快照并通知主频道订阅者（`transcript-view`/`mini-map` 因此每帧重渲）。建议：`#publish` 只在 `key` 为当前被订阅/展示的频道时改动 `#held`，或让主频道快照仅在主代理快照变化时重算。要动 `#held` 的读写语义，测试面较大，留待决策。

- `packages/conversation/src/transcript/transcript-store.ts:945` `#republishMedia` —— 媒体代取回来时若该对话已被 `forget`（`#media` 已 `#dropMedia`），第 931 行仍会重建 `#media` 条目，留下一份没有 owner、永不释放的缓存；`#republishMedia` 只在之后才发现 owner 没了。建议：回调里先确认 `#owners.get(thread)?.sessionId === sessionId` 再写缓存。属竞态收尾，风险低、优先级低。

- `packages/conversation/src/transcript/transcript-projector.ts:986` `projectTranscript` 的 `sealedCache`/`outlineCache` 是模块级变量 —— 不是 bug（每次调用写回、按引用比较），但它是进程内单点，多会话并发时两个会话交替投影会让引用稳定化互相打断。当前只影响 memo 命中率、不影响正确性；若将来做多窗口或多路并发投影，建议改为按 snapshot 记的 WeakMap。未改：无实测损失，避免无谓改动。

- `packages/conversation/src/surface/timeline/transcript-view.tsx:187-214` —— `renderRowAt` 每帧新建 `TimelineSeat` 元素，其 props（`row`/`group`/`seal`）引用现已稳定（本次修复后条目身份 churn 31/241401），故 `TimelineSeat`/`TimelineRow` 的 `memo` 已能生效。此处无需改动，仅记录：本次投影修复是这些 memo 真正起作用的前提。

- 工具链：`bunx biome check` 对 `transcript-projector.ts` 报两处 `noExcessiveCognitiveComplexity` **warning**（不是 error，`biome ci` 退出码仍为 0）：`framesOf` 曾 33、`outlineOf` 曾 24。本次已拆分到阈值以下（`projectStep`/`markOf`/`sameOutline`），当前该目录 0 error / 0 warning。
