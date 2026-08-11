# 0013 · 权限请求不占用 ACP 派发循环，子代理不另立 UI

状态：已采纳

## 背景

`crates/agent-runtime/src/driver.rs` 注册的 `RequestPermissionRequest` 处理器
曾在处理器体内 `await` 一个 `oneshot`，等待用户在界面上作答。

官方 Rust SDK 对处理器的语义是原子的（`docs/rfds/rust-sdk-v1.mdx`，
"Atomic handlers"）：一个 `on_*` 处理器返回之前，这条连接上不再处理任何一条
消息。因此那次等待冻结的不是一次提问，而是整条连接：本轮的 `session/update`、
其他会话的请求、以及 `session/cancel` 的回执全部停在门外。

## 子代理为什么必现

kimi-code 的 ACP 适配把子代理设计成**对客户端不透明**：
`packages/agent-contract-adapter/src/session.ts` 的 `onEvent` 首行即
`if (event.agentId !== undefined && event.agentId !== MAIN_AGENT_ID) return;`，
子代理的全部事件都不进 ACP；`test/session-prompt.test.ts` 的
`'ignores a subagent turn.ended and resolves on the main agent turn.ended'`
用例固定了这一语义。

而审批不在过滤范围内 —— `packages/agent-contract-adapter/src/approval.ts` 全文没有
`agentId` 判断。于是子代理回合在 ACP 上的形状就是"长时间静默 + 必来一次
`session/request_permission`"，一问即死。

`docs/en/reference/tools.md` 的 `AgentSwarm` 进一步放大这一路：最多 128 个
子代理，"5 subagents start immediately, then 1 more every 700 ms"。

## 决定一：等待搬出派发循环

等待搬进 `connection.spawn`，`responder` 随之移入（SDK 明写 `request_cx` 是
`Send`，并推荐 spawn）。处理器只做两件同步的事：把问题记进它所属会话，把等待
挂出去，然后立刻返回。

## 决定二：子代理不新增任何条目类型或界面

上游既然只交出父代理那一次 `Agent` 工具调用，客户端就只画那一张卡：
`events-map.ts` 的 `toolProgressToSessionUpdate` 把 `kind === 'status'` 的
进度刷成卡片标题，`toolResultToSessionUpdate` 以 `completed | failed` 收尾。
`ToolCallTimelineItem` 已经承载了这一切（`title`/`status`/`content`/
`rawInput`/`rawOutput`/`startedAt`/`endedAt`），子代理的
`description` 与 `subagent_type` 就在 `rawInput` 里，渲染层直接读。

因此不新增 `subagent` 条目类型、不新增 store、不新增面板、不新增事件过滤层。
新增它们不会带来任何多余的事实，只会带来永远填不满的空结构。

## 决定三："在飞"由终态判据决定，且只有一份

`feed-rows.ts` 的 `inFlightAt` 此前只看条目类型与所属段，不看 `status`，
于是本段内已经终结的工具卡也一直转纺锤。判据改为复用 `acp-projection.ts` 的
`isTerminal` —— `endedAt` 记不记也是照它，一个概念只留一处判断。

## 决定四：耗时计数留在组件层

一次 `Agent` 调用默认可以跑两小时（`[subagent] timeout_ms`，见
`docs/en/reference/tools.md`），期间标题可能长时间不变，所以在飞的卡片需要显示
已耗时。这一格由组件自己用时钟 tick 从 `startedAt` 算，**不得进入
`TimelineState`**：

- `acp-projection.ts` 的头注释承诺这一层"纯、总、可重放"，把 `now` 写进状态
  当场作废这三条；
- `feed-rows.ts` 的增量派生建立在 `items` 的引用相等上（`sharedPrefix` 是
  指针比较，`ROWS` / `FEEDS` 是身份表）。每秒推一帧会打掉全部共享前缀，退回
  它自己注释里批评过的"O(N)/帧"。

## 后果

- 一条会话在等人回答时，其他会话照常收发；swarm 的并发审批自然排队而非雪崩。
- 记录顺序不变：提问在处理器内同步记录，回答在 spawn 内记录，仍属同一会话。
- 回合结束时 `PermissionDesk::abandon` 丢掉发送端，spawn 内的等待观察到通道
  关闭，按协议答以 `cancelled`，语义与此前一致。
- 子代理运行期间界面近乎静默是**上游的设计**，不是缺陷。修复后的正确表现是：
  那一张工具卡持续 `in_progress`、可随时取消，同轮已完成的卡片安静下来。
