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
9. 378 项里有 **66 项跟这台桌面软件无关**，它们**不上屏**（不是折叠起来）。
   判据是「我们这条边车进程跑不跑得到它的读取点」，逐条对着 omp 18.3.0 的源码核过，
   理由与路径规则都写在 `packages/agent-bridge/src/settings-labels.ts` 的
   `irrelevantSettingOf`：终端渲染与配色（`tui.*` / `terminal.*` / `statusLine.*` /
   `theme.*` / 字形 / 输入区）、终端键盘与补全、终端语音、以及 agent 自己的启动与自更新
   （`startup.*` / `update.*` / `marketplace.*` —— 它在我们这儿是被嵌进来的，启动归宿主）。
   **按插件删除而不是收进折叠组**：画一格改了没有效果的控件就是骗人，它让人以为改了会变。
   代价是上游以后加同类格子我们的名单不会自动跟上；但那个代价远小于把「改了没效果」
   当设置摆给人看。
   - **判据只认路径，不认分节**。踩过的坑：`colorBlindMode`（「diff 新增用蓝色而不是绿色」）
     就住在 `Theme` 这一节里，而它改的是我们自己也画的 diff。拿分节当判据会连它一起删掉。
   - 拿不准的**留下**：`display.collapseCompacted` 的读取点是一个构建选项
     （`options.transcript && collapseCompactedHistory`，`session-context.ts:192/405`），
     不是纯终端，删它证据不足 —— 留着的成本远小于误删一个真能力。
10. **产品已有专属控件的格子，值照报、行不画**（`owned`）。这不是「有没有用」，是
    **一个事实两个控件**（AGENTS.md §1：每类状态有且只有一个所有者）：输入框那一排已经有
    计划 / 目标 / 思考档位 / 审批四个选择器，设置页「电脑控制」一节已经管着 `browser.*`
    三格。再在 agent 设置里摆一个同名开关，人会看到两个控件说同一件事 —— 改一个另一个
    不同步，而且没有任何迹象说明哪个算数。判据在 `ownedElsewhereOf`，每一行都指得到代码。
    - **只标不删，因为值还有别人要读**：界面按 `condition` 决定要不要画某些行
      （`plan.autosave` 要 `plan.enabled` 为真、`providers.autoThinkingMaxEffort` 要
      `defaultThinkingLevel` 是 auto），而判据读的就是目录里这一格的 value。把格子整个抽掉，
      那两行会永远不显示，屏幕上还没有任何迹象。这个坑是被 `settings-labels.test.ts` 那条
      「条件读的键必须还在目录里」当场抓住的。
    - 结果：目录报 312 格（值齐全），**界面画 305 行**。
11. 剩下的 305 行仍不是一屏能看完的目录，所以这一页另给两条出路：
    - **搜索**：跨栏找（找设置的人记得名字，不记得在哪一栏），中英文与路径都能命中。
    - **直接改它自己的配置文件**：路径由 agent 报（`getAgentDir()`），界面只负责交给
      系统编辑器。改完不必我们重读 —— 它自己看盘。
12. omp **没有 i18n**（实测：整个 `@oh-my-pi` 树零语言包、零翻译函数），所以中文只能
    我们出。译名表按 **path** 索引、不按英文原文索引，且**查不到就回落到 agent 的英文
    原文**：这是这张表作为「第二份事实」的唯一安全阀 —— 上游加一格设置时我们只是没翻，
    不会漏能力，也不会显示空白。栏目键、分节键、`path` 一律不译（译了同一节会分裂），
    中文只落在给人看的那一列（`label` / `groupLabel` / 栏名）。**标题与说明两列都译**：
    说明是用户拿来决定要不要改这一格的东西（`settings-descriptions.ts`，312 格全译）。
13. 配置文件那条命令的路径**现问 agent**，不从前端收：能把任意字符串交给系统 shell 的
    命令不能由调用方任选（同 `window_open_external_url` 那条纪律）。
14. 译名不抄上游的英文分节名当键：分节的**键**是 agent 的词，**名**才是我们的译文
    （`groupLabel`）。栏名同理，且栏键与栏名成对给（`SettingsTab{key,label}`）——
    两条并行数组一旦错位就是「点了外观出来模型」，而这种错没有任何读法能发现。
15. 说明表分三片维护（a/b/c），合并只在 `settings-descriptions.ts` 一处发生。
    分片是为了「译」能并行且每片小到一次翻完：第一版让一个 agent 同时枚举 312 条
    （3.1 万字符）再翻译，它枚举完就没上下文了，一个字都没写出来。
    合并后由 `settings-descriptions.test.ts` 双向比对键集 —— 判据是被真实缺陷逼出来的：
    一位译者凭印象多写了三个上游没有的键，`biome` 与肉眼都发现不了，只有键集双向比对才现形。

## 会话的增删查导（同一批接上）

16. `fork_session` 的上游原语是 **`AgentSession#branch(entryId)`**（它调
    `createBranchedSession` 再重锚：id 同步、消息替换、记忆重键、bash 过渡都在里面），
    **不是 `SessionManager#fork()`** —— 后者整份复制、一轮都不丢，做不出「丢 N 轮」这个
    契约。`dropTurns === 0` 才走 `AgentSession#fork()`，且它**不能持久化时返回 false 而不是抛**，
    必须当成失败（报一件没发生的事比报失败坏得多）。`dropTurns` 超出实际轮数**抛错不夹边界**：
    静默夹会让「丢 5 轮」变成「丢 3 轮」而没人知道。
17. 分叉是一次**现场换会话**：agent 那边的活会话已经是新的那一条。所以两侧都要接住 ——
    Rust 侧把它走成与 `LoadSession` 同一条 `assigning` 路（应答换掉连接上的号），
    桥侧 `rebind` 换掉 `sessions` 表里的号、并给新号配**新的投影器与镜像**（分叉出来的是
    另一条会话，把两条会话的帧缝进同一个镜像会让「这条会话有哪些帧」变成假的）。
    分叉前先校验请求的号就是当前活会话：不校验就会分叉错的那一条。
18. `sessions` 只报 `sessionId` / `title` / `updatedAt` 三格，**绝不原样转发上游的
    `SessionInfo`** —— 它还带 `allMessagesText`（整条会话的全文），原样发会顶穿单行上限
    （1 MiB），Rust 那边直接判连接死掉。实测一条清单 260 字节。
    范围是这条连接的工作区（`SessionManager.list(cwd)`，一个连接一条会话、锚一个工作区）。
19. `delete_session` 必须先经过**正持有那条会话的 `SessionManager`**：它拿着写句柄，
    绕过它删文件会让句柄指着已不存在的路径，下一次说话把文件又写回来。只有没载进来的
    会话才新开一个存储去删。删完把记录从 `sessions` 拿掉、必要时清 `active` ——
    留着记录会让文件复活。找不到就抛错：运行时把这笔删除当成还欠着，稍后重试。
20. `export_session` 当前会话走 `agent.exportToHtml`（带 systemPrompt 与工具段，最全），
    其余走 `exportFromFile`（按文件独立导出，不必装载）。

## 未采纳

- **给审批另立一条 IPC/事件通道**：既有那条回路已经通，缺的是生产者，不是通道。
- **把条件求值搬到 Rust**：条件表在 `pi-tui`，且要用此刻的设置；搬过去就是第二份判据。
- **在 Rust 里解析 omp 的题组**：那是 agent 专属形状，放通用层即 §4 的缺陷。
- **计划正文内联渲染**：transcript 的 plan 帧留了位置，但还没有生产者；先让带子把人
  引到计划文件，不假装已经有了。
- **把 312 项砍成「常用十几项」**：那是替用户判断哪项有用。`advisor.*`、`images.urls.*`、
  `memory.*`、`lsp.*`、`compaction.*`、`tools.*` 都是真能力开关，砍掉正好背离这个 ADR
  的目标。砍的是「在这台软件里跑不到读取点」的那 66 项，不是「我们觉得用不上的」。
- **把终端那些收进折叠组**（曾采纳过一版）：折叠仍然把它们摆在设置页里，人点开就会改，
  改了却没有效果。删除与折叠的差别是「不误导」与「少占地方」，前者才是这条要的。
