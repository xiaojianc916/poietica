# 0017. 一个子代理就是主时间线上的一次工具调用

- 状态：已接受
- 日期：2026-08-04
- 相关：0016（kimi 跑在 acp-v2 入口）

## 背景

派子代理这件事，我们先后按两种猜测做过设计：先以为"上游会回传子代理的事件流，只是被
过滤掉了"，后以为"换到 acp-v2 就会来"。两种都不对。

证据（`MoonshotAI/kimi-code`，head `c396873`）：

- `packages/agent-contract-server/src/session.ts` 构造函数逐字 `this.agent = this.session.agent('main')`，
  `init()` 第一行 `const events = this.agent.events`。`assistant.delta` /
  `tool.call.started` / `tool.call.delta` / `tool.progress` / `tool.result` /
  `turn.ended` 六个订阅全挂在这一个 handle 上 —— 一个 ACP 会话跟的是**主代理**。
  这里没有过滤器：是订阅范围里就没有子代理。
- 同文件 `onTerminalCreated` 的注释逐字自证：
  "Terminals with no matching call (e.g. a subagent's — this session only follows the
  main agent's events) stay unattached."
- 旧那套 `packages/agent-contract-adapter/src/session.ts` 是另一种写法、同一个结果：
  `if (event.agentId !== undefined && event.agentId !== MAIN_AGENT_ID) return;`
- 而引擎层 `agent-core-v2/src/session/agentLifecycle/agentLifecycle.ts` 逐字：
  "No agent id is special: the main agent is an ordinary agent whose only distinction is
  the conventional `MAIN_AGENT_ID`" —— 子代理在引擎里是一等公民。

所以这个口子是 ACP 这一层**故意**只开一个，不是版本差异，也不是配置项，更不是我们
接错了：它是上游服务端的设计边界。

## 决定

一个子代理，在我们这边**只有一种表示**：主时间线上的一次工具调用卡片。

上游唯一交给我们的是那次派发的入参（`subagent_type` / `description` / `prompt` /
`run_in_background`），`domain/sub-agent.ts` 负责把它读出来。除此之外，运行期没有
任何可显示的进展。审批是唯一的例外，因为它走的不是事件流而是会话作用域的
interactions（见 0016），所以它到得了客户端 —— 这也正是子代理此前会卡死、迁移之后
不再卡死的全部原因。

## 后果

- 不做嵌套子流、不做"子代理会话"视图、不做等待子代理事件的加载态：数据源不存在。
- 运行期抽屉里画那份任务书是**正解**而不是占位 —— 那是这段时间里唯一诚实的内容。
- "一屏并行子代理的聚合与折叠"，范围因此缩小为"渲染期给一排同类工具卡分组"，
  与任何多路流聚合无关。
- 这条不变式钉不到单元测试上：它是上游的行为，不是我们的函数。所以它钉在这份 ADR
  和 `domain/sub-agent.ts` 的头注里，而不是钉在一条自己造事实的断言上。头注此前写的
  是旧那套的 `agentId` 过滤机制，随本次一起改正。
- 若将来上游开放子代理事件（那需要 ACP 侧新增一个 agent 维度），本 ADR 作废，届时
  重新写一份，而不是在这份上打补丁。
