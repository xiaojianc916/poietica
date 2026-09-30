# 0025 — 子代理的生死走 agent 自己的观测总线，能力开关如实报

## 状态

已接受。补 0016/0017/0018 的执行细节：那几号决定了「用 SDK、元数据全从 agent 读、
未结交互上屏」，这一号决定「agent 派出去的子代理屏幕上有没有」与「本机能力那一格报的
是什么」。

## 背景

两处 SDK 已经给了、我们却没收的东西：

1. **omp 的子代理观测面从来没有接上。** `createAgentSession` 的返回值里有
   `subagentEventBus`（`sdk.ts:704`）—— 根作用域总线，这条会话树里全部子代理的
   `task:subagent:lifecycle|progress|event` 都推在它上面。omp 自己的 RPC 宿主正是拿它
   建 `RpcSubagentRegistry`（`modes/rpc/rpc-subagents.ts:107`）。我们的
   `adopt()` 把这个字段**解构掉了**，一个订阅都没建。
   后果与 0018 决定一逐字同形：一条链上每一环都在，只是没有人产那一条 op ——
   `packages/transcript` 早钉好了 `task.upsert` 与 `kind: 'subagent'`
   （`contract/schema.ts:209-225`），状态面板早会画、还会跑秒针 —— 而全仓
   `task.upsert` 的生产者是零个。子代理照常跑（`task` 工具在模型手里），
   屏幕上一条都看不见。
2. **能力那一格在说谎。** `capabilities` 命令恒报
   `state: 'ready', supported: true`，而 omp 的 `computer.enabled` 默认是 **false**
   （`config/settings-schema.ts:4375-4384`）。屏幕于是说「已就绪」，模型手上却没有那个
   前奏。同一件事的另一半：`install_capability` 是死路（`client.rs` 的
   `unwired`），设置页那颗「安装」按钮点了只会报「还没接」。

## 决定一 · 子代理的生死由 agent 的总线来，桥只做投影

订阅 `subagentEventBus` 的 `lifecycle` 与 `progress` 两个频道，投影成
`task.upsert`。第三个频道 `task:subagent:event` **不订**：那是每个子代理的原始
`AgentSessionEvent` 洪流，官方也只在 `events` 级订阅时才发（`RpcSubagentRegistry`
的 `handleEvent` 先看订阅级别）。我们要的是「这一行在不在跑」，不是第二份正文
（§1「屏幕经过由 agent transcript 提供」——子代理的正文有它自己的会话文件）。

**状态词逐档对应，不猜。** omp 的 `started|completed|failed|aborted` →
`running|completed|failed|killed`。`aborted` 落 `killed` 而不是 `timed_out`：
后者说的是超时，那是另一件事。认不出的词整帧丢掉 —— 猜成 `failed` 会让屏幕上凭空
多一行「失败」。

**终态是终态。** 已结的行不许被翻回运行中：omp 会补发迟到的帧，而一行已完成的账被改回
「运行中」，人读到的是不存在的历史。收尾的进度帧同理不再改写已结的行。

**同一份投影不重发。** 进度帧每 150ms 一条（`task/executor.ts` 的
`PROGRESS_COALESCE_MS`），原样转发就是每 150ms 一次整格替换。账里比过才发 ——
这是 §5「引用不变则不通知」在 ops 层的写法。

**总线载荷按结构收窄。** 帧类型是 `unknown`，逐格取用前过一道
`lifecycleFrameOf` / `progressFrameOf`；取不到必需的号就整帧作废。

**落哪一节由 `kind` 决定，不由 `detached` 决定。** 投影层原来只按 `detached`
分派，`kind` 那个判别式**读了却没用**：子代理于是全落进「后台任务」—— 那一节的
图标是终端、值叫 `terminals`。修法是两半：

- `backgroundOf` 收窄到 `kind !== 'subagent'`（detached 只说「父轮不等它」，
  不说明它是什么）；
- 新增 `subagentOf`（判据 `kind === 'subagent'`）与 `TimelineState.subagents`，
  「智能体」那一节画它。**同步子代理一样算**：官方 TUI 的 HUD 也列它们。

「智能体」那一节有两个来源，折成同一个行形状：总线帧（detached 子代理的唯一真相 ——
发起它的调用早返回了），以及时间线上的 delegate 工具调用（重开旧对话时总线上没有任何
帧，历史仍要画）。**有总线帧就用总线帧**：两条都画会把同一个子代理列两遍。

## 决定二 · 能力那一格报「此刻开没开」，不报一份目录

`capabilities` 从 `computer.enabled` 与 `getEvalPreludes()` 如实读：

- `ready` = 开着（前奏进了系统提示词）；
- `notInstalled` = 这块能力在，但关着；
- `unsupported` = 这个构建里没有。

**不能拿 `getEvalPreludes()` 当可用性判据**：那一支在 `computer.enabled` 为假时整份
交回空表（`sdk.ts:2009-2021` 的 `if (settings.get("computer.enabled"))`），于是
「关着」与「这个构建没有」会读成同一件事，界面就说不出「装好了但你关着」。
可用性因此报构建事实，真正的平台可用性在**打开那一刻**按 omp 官方做法验、验不过就回滚
（见决定三）。

`install_capability` 不再是死路：它收成官方那两步，并带一个方向（开/关）。
omp 里这一项没有「安装」这一步 —— 桌面控制是构建期编进来的 eval 前奏
（`sdk.ts:244` 的静态 import），只有开与关。命令名留在线上是为了不动已生成的 IPC 契约；
语义在桥里如实收成「切换」，应答是**改完之后的整份清单**（与 `capability_report` 同形：
一次开关可能牵动清单里别的项，只回被点的那一项就是让调用方去猜）。

## 决定三 · 开关走持久写入面 + 刷新系统提示词，失败即回滚

官方 `/computer` 的两步是 `settings.override("computer.enabled", …)` +
`refreshBaseSystemPrompt()`（`slash-commands/builtin-modes.ts:122-138`）。我们取它的
**持久**写入面（`set` + `flush`）而不是 override：官方那一格是会话内的临时开关
（官方注释逐字「The override is never persisted to settings.json」），而我们这一格是
设置页上的持久控件 —— 关掉再开一次之后必须还在。

次序照官方：**先落设置，再验前奏，最后刷新提示词**。验前奏必须在写之后 —— 前奏是惰性
建的，写之前读恒是空表，那会把「这块能力能用」一律读成「不能用」。任何一步失败都把
设置还原并重新落盘：留着它等于报了一件没发生的事。

`computer.enabled` 因此进了 `CONTROLLED_ELSEWHERE`（`settings-labels.ts`）：
它的行由「电脑控制」页那一颗开关负责，agent 设置页不再画第二个控件（§1：一个事实
一个控件）。值照旧报 —— 别的格子按 `condition` 读它。

## 后果

1. `packages/agent-bridge` 新增 `subagents.ts`（`SubagentLedger`：帧 → `task.upsert`，
   含去重与终态守卫）；`bridge.ts` 的 `adopt()` 接上 `subagentEventBus` 的两个频道，
   `Session` 多两格（账与退订函数），删会话与收摊时一并退订。
2. `install_capability` 贯通三层：`protocol.ts` 加一格（带 `enabled`）、
   `wire.rs` 的 `Command::InstallCapability`、`client.rs` 的
   `install_capability(id, enabled) -> Vec<Capability>`、`conversation-runtime` 的
   `capability_install`、Tauri 的 `AgentCapabilityInstallRequest.enabled`，
   `ipc:generate` 重新生成绑定（`agentCapabilityInstall` 现在交回 `AgentCapability[]`）。
3. `CapabilityGateway.installCapability` 与 `PluginStore.installCapability` 收
   `enabled`，落账时**整份替换**清单而不是按项合并 —— agent 交回的是「改完之后全部项
   长什么样」，按项合并会把别的项的变化吞掉。
4. 「电脑控制」页的 `ready` 从「什么都不给」改成**开关**：把 ready 画成没有控件，
   点开之后就再也关不掉，那是一道单向门。`installable` 与 `ready` 因此都是开关
   （omp 里这一项只有开与关）。
5. 界面一个控件都不删（与 0016 第 5 条同一条纪律）。

## 待验证

- 一次真实子代理轮次的三个频道帧序（当前只按官方 `executor.ts` 的发射点核对形状：
  `started` 在 `emitSubagentFrame` 的 2871/3245/3980 行，`settled` 在 2565 行，
  进度在 1428 行）。
- `task.batch` 批量形态下一次调用多个子代理时，`progress.index` 与行的一一对应。
- 非 Windows 平台上 `computer.enabled` 打开后 `getEvalPreludes()` 的真实结果
  （pi-natives 的 DesktopSession 在 macOS/Linux 上的可用性）。
