# 0054 — 等人的那件事要上屏，agent 自己的设置要能改

## 状态

已接受。补 0052/0053 的执行细节：那两号决定了「用 SDK、元数据全从 agent 读」，这一号
决定「agent 在等人答的时候屏幕上有什么」与「agent 自己那 378 格设置谁来画」。

## 背景

两条能力在 SDK 里都在，在我们这条线上却是断的：

1. **屏幕看得见审批这一格从来没接上。** 协议与投影层早就支持
   `interaction.upsert`（`packages/transcript` 的 op 与 reducer、
   `transcript-projector.ts` 的 `phaseOf`/`interactionOf`、
   `timeline-queries.ts` 的 `pendingInteractions`、`permission-dock.tsx` 三颗按钮），
   但从没有人产过这一条 op。后果是一条链上的每一环都空转：`phaseOf` 永远导不出
   `awaiting_permission`，`PermissionDock` 永远不挂载。授权问答**整条回路是通的**
   （人点下去 → `agent_resolve_permission` → `PermissionDesk` → `answer_permission`
   → 上游），只是没有人被问到。
2. **omp 自己的设置面板我们没有。** omp 有 503 个设置键，其中 378 个带完整 UI 元数据
   （label / description / 类型 / 选项 / 默认值 / 风险提示 / 可见性条件）。它的 TUI
   整页由这份元数据渲染。我们只开了三条写路（`browser.*`、`tools.approvalMode`、
   `modelRoles.default`），剩下约 370 格（LSP、压缩、记忆后端、MCP、技能、子代理、
   TTS、ast-grep、checkpoint、安全扫描、secrets…）在 SDK 里够得着，界面上没有入口。

## 决定一 · 未结交互由桥产一条 op，号与答复同号

桥订阅 `uiContext` 那次对话框的开门与关门，产 `interaction.upsert`：
`state:'pending'` 开门，`approved`/`rejected`/`cancelled` 关门。

**`interactionId` 就是上游那次对话框的号（`d1`…）。** 这不是省事：同一号已经流过
`agent_resolve_permission` → `PermissionDesk` → `answer_permission` → `desk.settle`，
屏幕上的按钮与答复的键因此逐字相等。另编一个号就要两张表的对账，而那个对账一旦错位，
人点了按钮、答复落到一个没人等的号上，上游永远卡着 —— 症状与「没有审批界面」一模一样。

审批与提问走同一个号空间（都是 `extension_ui_request` 的 id），但**分成两类**
（`approval` / `question`）：它们要画的东西不同，`phaseOf` 也按这两类决出相位。

## 决定二 · 「本次会话都批准」是真的会话级放行

产品那三颗按钮里第三颗此前只是「再点一次批准」：上游的 `select` 只有两颗
（`Approve`/`Deny`），一次只放行这一次，`labelFor` 把 scope 整个丢掉了。

真正的会话级放行是**另一条设置**：`tools.approval.<tool>: allow`。上游
`resolveApproval` 先查用户策略（`tools/approval.ts:283-291`），所以写进去才作数。
桥在答复之前把它写进 agent 自己的 config（`Settings.set` + `flush`，它自己热重载）。

`scope` 因此是我们自己加的一格：上游没有它，而产品必须分得清人点的是哪一颗。
同理 `cancelled` 也自己带一格 —— 上游把「拒绝」与「取消」都读成 undefined，
屏幕上它们是两件事。

## 决定三 · 计划批准走同一条带子

计划模式此前**自动批准**（照官方 ACP 宿主对无表单客户端的做法），注释里写着
「这版还没有能答这个问题的界面」。现在有了，所以计划提交问人。

它复用闸门那张选项表（判据是选项集），因此屏幕上是同一颗带子、同一道
`answer_permission`，不需要第二套控件。人不批时**留在计划模式里** —— 出模式等于
告诉模型可以动手了。

## 决定四 · omp 的设置由它的元数据生成，不抄一份

`settings-schema.ts` 导出 `getUi` / `getType` / `getDefault` / `getEnumValues` /
`isCredential` / `hasUi`。桥逐格读出来交给屏幕，**一格文案都不抄**：

- 抄一份就是第二个事实（§0）：上游加一格、改一句说明，我们静默落后；
- 界面按 `type` 与 `options` 选控件（boolean→开关、enum→下拉、number/string→输入），
  没有 per-setting 的表单代码；
- `ui.warning` 原样上屏（那是上游给「可能被限流/封号」那类设置的警示）；
- `ui.condition` 只搬**名字**，不求值：条件表在 `pi-tui`，判据要用**此刻的设置**，
  那是界面这一侧的事。

**钥匙那三格只有「有没有配」出去。** 值出了 agent 的进程就不再是我们的盘（§1）。
写成测试而不是靠小心：载荷序列化之后查一遍，钥匙的明文一个字都不许出现。

## 决定五 · 提问折到产品形状，号由桥签发

omp 的 `ask` 题组（`tools/ask.ts:60-72`）选项只有标签、没有号，还带 `preview` /
`recommended`。这些是 agent 专属形状，**折在桥里**（§4：agent 专属知识只许住在
agent 的专属模块），Rust 只搬产品形状。

- 选项的号由桥签发（`o0`、`o1`…），答复按号回来，桥再折回标签 —— 上游收的是标签
  （`ask.ts:940-1010`），折错一个就等于替人答了另一个选项；
- `allowOther` 恒真：上游恒定给「Other」（`ask.ts:42`）；
- 产品的整组备注挂到第一题（上游的 note 是每题一格）：分散会在一句话里重复；
- 少答一题、认不出的号都当「没答」交给上游 —— 上游因此读成取消，而不是我们替人挑。

## 后果

1. `packages/agent-bridge` 新增 `questions.ts`（omp 题组 ↔ 产品题组）与
   `settings.ts`（设置目录），`projection.ts` 新增 `interactionOp`，
   `DialogDesk` 新增开门/关门观察者。桥的协议版本升到 2。
2. `PermissionItem` 新增 `headline`：带子上印的是**将做什么**（上游
   `formatApprovalPrompt` 拼好的 `Command: …` / 路径 / 新旧正文），不是工具名。
   「要不要允许 Bash」回答不了任何问题。
3. Rust 侧接线在 `crates/agent-client`：`questions_asked` 落在 `QuestionDesk` 上，
   答复经既有的 `AnswerDialog` 命令送回（那一条命令此前没有调用方）。提问的号与答复的
   号必须是同一格 —— 换一个号，桥的 `desk.settle` 就认不出是谁在等。
4. 界面一个控件都不删（与 0052 第 5 条同一条纪律）。此前画不出来的提问面板与审批带
   现在有生产者了，组件本身不改。
5. 0053 的「待验证」第 2 条（逐工具策略是否需要暴露）就此收敛：**需要**，
   且它正是「本次会话都批准」的落点。
6. 设置目录实测（18.3.0）：503 个键，其中 378 个带 ui 元数据、上屏十个栏目
   （appearance/model/interaction/context/memory/files/shell/tools/tasks/providers）。
   钥匙**只报有没有配**：`isCredential` 认得出 8 条，其中 3 条有 ui 元数据
   （`mnemopi.embeddingApiKey`、`mnemopi.llmApiKey`、`hindsight.apiToken`），
   也只有这 3 条上屏 —— `ui.secret` 在 18.3.0 里一处都没有，所以判据是
   `isCredential && hasUi`，不是那个字段。两侧各自再折一次（桥折成 `hasValue`，
   Rust 侧无条件把 `value` 置空），任一侧失守都不至于漏出去。
7. 每一次「问人」都必须有收场：答复、超时、中止三条路归到**一个结账点**，
   且中止要连**已经作废**的信号一起认（`addEventListener('abort')` 只在 abort
   之后触发，漏了那一格，作废的对话框会永远留在等人答的表里）。判据有测试
   （`__tests__/dialog-lifecycle.test.ts` 与 `dialog-abort.test.ts`）。
8. 取消一轮与收摊都要把挂着问话结掉（`DialogDesk::closeAll`）。上游授权闸门问的
   那一次 `select` **不带 signal**（`extensions/wrapper.ts:333`），它不会因为这一轮
   被取消而自己作罢 —— 谁都不结它，那次调用就永远停在 await 上，屏幕上的带子也
   永远停在「等你批」。这一条有测试（`__tests__/cancel-drains-dialogs.test.ts`）。

## 未采纳

- **给审批另立一条 IPC/事件通道**：既有那条回路已经通，缺的是生产者，不是通道。
- **把条件求值搬到 Rust**：条件表在 `pi-tui`，且要用此刻的设置；搬过去就是第二份判据。
- **在 Rust 里解析 omp 的题组**：那是 agent 专属形状，放通用层即 §4 的缺陷。
- **计划正文内联渲染**：transcript 的 plan 帧留了位置，但还没有生产者；先让带子把人
  引到计划文件，不假装已经有了。
