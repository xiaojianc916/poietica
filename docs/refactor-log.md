# 重构日志

本页只留三类**当下仍然有用**的东西：待决问题、偏差与裁决、以及仍在约束代码的历史结论。
每次任务的执行过程、方案复述、测试计数已删除 —— 需要原文时用 `git log -- docs/refactor-log.md`
查旧版本（每个条目的提交说明里也有摘要）。

新增记录：只写「为什么这样做」「和方案哪里不一致」「还没决定什么」。不要抄方案正文。

## 待决问题

| 编号 | 日期 | 问题 | 现状 / 处置 |
|---|---|---|---|
| Q2 | 2026-10-05 | `tooling/depcruise/config.cjs` 曾 require `swc-tsx.cjs` 补丁（旧版 dependency-cruiser 不认 tsx） | **已关闭**：新版自带 `getOptionsFor()`，shim 已删 |
| Q21 | 2026-10-05 | `mcp.upsert` 的「新增重名 → `mcp_name_conflict`」在 Core 侧**不可达**：参数只有 `McpServerInfo`，线上没有区分新增 / 更新的位 | 未决。按幂等 upsert 实现（同名即更新），错误码保留。改法二选一：契约加意图位，或 UI 走独立的新增方法 |
| Q22 | 2026-10-06 | 设置页「启动项 / 守护进程」组缺失：`preferences.general` 契约里没有 `daemon` 字段 | 未决。等方案补落点（「已归档」页已于 2026-10-07 裁决并落地） |
| Q28 | 2026-10-07 | 图片进模型上下文的通道 | **已裁决**：删掉 `media(fileId)`，图片只走内联（`attachment.upsert` 的 data URL） |
| Q32 | 2026-10-09 | `~/.agents` 曾被列入 14 个外来 provider 的禁用表，导致 `~/.agents/skills` 的技能不出现 | **已裁决**：按 legacy 放行 `agents`（14 → 13），新增 `RELEASED_PROVIDERS` 供升级时撤销旧禁用 |
| Q33 | 2026-10-09 | `auto_compaction_end` 的 `timelineReset('main')` 会在开着轮时整页重取，与增量投影编号打架 | **已结清（R-21）**：压缩收口改走增量 op，不再重取；`timelineReset` 只留给 `/compact` 这类本地命令（`session.ts`） |
| Q39 | 2026-10-10 | 只是「看一眼」历史对话也要冷启动完整 AgentSession：`timeline.subscribe` / `controls.get` 都 acquire（拉起工具与 MCP） | **时间线已结清（性能方案 P1）**：引擎端口加只读 `sessionFiles.readPage`（与「重开再 page()」同一页，一致性 C-READ-PAGE），`timeline.subscribe` / `timeline.page` 不再 acquire；打开时只给这一代发过增量的通道换代（`TimelineHub.resetAdvanced`），「先 acquire 再取位置」的前提随之撤掉。**其余读也已结清（性能方案 P4）**：`controls.get` 冷读线程行上的控件表快照（`conversation_threads.controls_snapshot`，迁移 v5；活会话每次 `controls` / `contextUsage` 事件回写，内容相同不写），`queue.get` 冷读为空队列加待发清单，`commands.list` 冷读引擎 `commandCatalog(cwd, { history })`，`side.list` 冷读引擎端口 `sessionFiles.sideTopics`（一致性 C-SIDE-READ / C-COMMAND-CATALOG）；UI 不再在挂载/切换时 `threads.open`，改为输入框获得焦点或拖入文件（写意图）时预热，发送照旧 acquire。没有快照的旧线程首次查看仍 acquire 一次以自愈 |
| Q40 | 2026-10-12 | ticker 极快档（≥200 字/秒）仍有可见顿挫：应动未动 41%、sJ90 1.43。正确性不受影响 | 已知局限，不跟踪；真机若明显再让设定值随速度变化 |
| Q41 | 2026-10-12 | 换句的上下刷仍带 260ms 透明度变化；规格给了「翻牌式」可选项 | 未决，等真机观感定 |
| Q43 | 2026-10-14 | `docs/omp-sdk-reference.md` 曾停在 18.5.0（relay 缺陷正是照旧文档核对漏出来的） | **已结清（R-33）**：行号锚点可机检（`check:omp-doc`）。升级 omp 时仍按 AGENTS §11 逐项核对内容 |
| Q44 | 2026-10-14 | MCP 配置四个死键（`bearerTokenEnvVar` / `toolTimeoutMs` / `enabledTools` / `disabledTools`）+ 名称校验与 omp 的 `validateServerName` 错位 | **已结清（2026-10-17）**：死键连同 `startupTimeoutMs` 一起删，改用 omp 认的 `timeout`；名称按 omp 判据在表单本地判；Core 写盘前再用 omp 的校验拦一次 |
| Q45 / Q47 | 2026-10-14 | `features/browser/src/host/relay-protocol.ts` 是 omp 内部协议的**副本**（omp 未导出稳定契约） | **已结清（分层审查 2026-10-19）**：协议移进引擎端口（`packages/engine/src/browser-relay.ts`），与 omp 的对齐由 `engine-omp/src/browser-relay-conformance.ts` 在 `typecheck` 里机检（移入时即查出 `cdpEvent.params` 已漂成 `unknown`）。端口与口令改由引擎自备：`AgentEngine.browserRelay()` → browser 的 Core 模块 `browser.relayEndpoint` → Host；`CoreSupervisor` / `CoreCaller` / 启动参数不再认识 relay |
| Q46 | 2026-10-16 | `runtime-layout/src/core-args.ts` 的 33 行 argv 解析可用 `node:util.parseArgs` 替，但它接受 `--k=v`、报错是英文 `ERR_PARSE_ARGS_*`，而 9 条用例钉的是中文文案与「参数重复」语义 | 未决，属可接受的行为变更，需产品裁决 |
| Q48 | 2026-10-16 | `omp-version.ts` 兜底值写死 `'18.5.0'`，会进 `core.ready` 与 `diagnostics.core` | **已结清（R-33）**：改为现读随包 omp 的 `package.json`，读不到才是 `0.0.0-unknown` |
| Q49 | 2026-10-19 | 分叉标题的序号只在「源名已带后缀」时进一档：同一个对话分叉两次（兄弟分支）会得到两个同名 `X（分支）` | 未决。可选路径：落标题前按同工作区现有标题去重（撞名进一档），或就允许重名。当前实现只做链式分叉的递增，兄弟分支不去重 |
| Q50 | 2026-10-21 | 输入框有**两份草稿模型**：按线程的 `stores.composer`（`ConversationUiToken.composerOf` / `activeComposer` 写它，持久化草稿也只回填它）与屏幕上的 Lexical 编辑器（`prompt-input`，离屏存 `ComposerDrafts`）互不相通。intelligent-ui、浏览器拾取投递、审查页经 `composerOf` 插进去的字 / 附件**从不出现在输入框里** | 部分处置（R-48）：加「在屏输入框登记表」`composer/live-composers.ts`，对话格的编辑器挂载时登记自己的 `ContributedDraft`，`composerOf(id)` 先找在屏的那份、找不到才退回 `stores.composer`。离屏线程的插入与持久化草稿回填仍走旧模型，彻底统一需让编辑器以 `stores.composer` 为唯一事实源（或删掉后者），属单独一次重构 |

## 其他待办（无编号）

| 日期 | 待办 | 依据 |
|---|---|---|
| 2026-10-12 | `node:sqlite` 的 `setAuthorizer` 用不上：受「一条连接服务多模块」架构限制 | 用官方能力替换（2026-10-14）裁决保留 |
| 2026-10-13 | `tooling/checks/ticker-layout/run.ts` 的 `ELECTRON` 常量写死 `node_modules/electron/dist/electron.exe`；改走 `require.resolve('electron')` + `path.txt` 更稳（isolated linker 下前者不成立） | 目录整理 |
| 2026-10-14 | 代码审查页的 Issues 一栏恒为 0（PR 之外不做）；Changes 标签只给统计、不画 diff | 审查页三栏 |
| 2026-10-17 | 自定义服务商的编辑表单读不到原 Base URL 与 API 格式：`ProviderInfo` 不带这两项，`catalog-port.ts` 的 `baseUrl` 恒为 `null`，直接保存会把 Base URL 写成空 | U-02。要补契约字段，建议单独处理 |
| 2026-10-17 | 入口页的选择会改模型页的「默认」标记（同一份意图，收敛的本意）。若产品要「入口页只管这一次」，需另起会话级覆盖 | Q1-二期 |
| 2026-10-18 | `features/review/src/core/__tests__/service.test.ts` 用 `test.skip` 兜底：没有 git 的机器上 19 条静默跳过。改成「缺 git 就红」需拍板 | T-01 |
| 2026-10-18 | `features/platform/src/ui/__tests__/format-bytes.test.ts` 测的是 design-system 的 `formatBytes`，位置不对；挪它要动 `editor-project-map` 闸门的收录范围 | T-01 |
| 2026-10-18 | `RING_MAX_CHARS` 仍为 8MB：没有真机帧大小分布，调小会让长工具输出更早退化成整页重读 | A–E（P-05 的理由） |
| 2026-10-18 | 自动化新线程的保留策略、fork 改为共享前缀、omp gc 的 archive / wal / stale 三段、按时间清理缓存：方案明确不做 | F-01 §7 |
| 2026-10-18 | Windows 真机核对未做：启动 1 分钟后浏览器缓存回落、聊天变大 / Agent 数据变小、删带截图对话后 `session media collected`、`core:build` / `core:probe` 的干净机器验证 | F-01 §6 |
| 2026-10-18 | `enforceBudgets` 的 `clearCache` 返回后立刻量目录，Windows 上删除落盘可能滞后，`freedBytes` 可能偏小（显示「腾出 0 B」）：已知近似 | F-01 §7 |
| 2026-10-18 | `pathKey` 只做 `resolve` + Windows 小写，不做 `realpath` / 8.3 短名归一；junction / 短名场景下 `skip` 集合可能匹配不上而重复计数（构造上本机不触发） | F-01 §7 |
| 2026-10-18 | fork 失败路径两处健壮性：`thread-service` 的 `enqueue` 抛错会覆盖原始 insert 错误；`session-files` 的 `forked.close()` 抛错会跳过 `discard` | F-01 §7 |
| 2026-10-18 | `tooling/checks/review-page/run.ts` 仍自己起 `gh` 取冒烟数据（tooling 不能 import 功能源码，也不在 `bun run all` 里） | R-36 |
| 2026-10-18 | `listProcesses` 每次约 0.5s（PowerShell 起进程开销），启动与关停各一次。**已结清（性能方案 P3）**：清残留只问 Core 的映像名（`listCoreProcesses`），先用 tasklist 问「有没有」，常态不起 PowerShell；真有同名进程才用 WQL 过滤只取那几行。首次启动那一次在 Host 拿到单实例锁时就发起，与 Electron 初始化、建窗并行；Core 在窗口挂上总机后就启动，不再排在全部 onReady 之后。**真机核对时发现并顺手修掉一个会把收益吃掉的旧 bug**：CIM 输出保留 `Name` / `ExecutablePath` / `CommandLine` 的原始大小写，而 `parseProcessList` 只读小写键，导致名字 / 路径 / 命令行全是空串、`findStaleCoreProcesses` 一个残留也认不出（P3 只按名字预筛会把这个空串原样放大）。解析改成两种大小写都认，并用真实 PowerShell 输出钉了用例 | R-37 |
| 2026-10-21 | 测试不按平台跳过：Linux 上 `bun test` 稳定 62 失败 + 1 error（Windows 路径、PowerShell、`.exe` 等），另有 `agent-activity-feed.test.tsx` 两条（happy-dom 下 `offsetHeight` 桩不生效）与 `goal-continuation.test.ts` C4 满载超时。CI 只跑 windows-latest，所以从没红过；要么给平台专属用例加 `test.skipIf(process.platform !== 'win32')`，要么 CI 加一条 ubuntu 任务 | R-48 审查 |
| 2026-10-20 | `PartSkeleton`（`.workbench__skeleton`：`--ui-muted` 40%）对其它懒加载部位同样是一块突兀的灰：深色主题下加载一闪而过就是一次「闪灰」。可改为延迟约 150ms 再出现，或按所在部位的底色画 | R-49 |
| 2026-10-22 | 右坞「文件」（R-50）没做的：树的右键菜单（`ContextMenu*` 模块已按零引用删除，要用得先恢复）；查看器只着色 `highlighter.ts` 已登记的语言；Markdown 预览里的相对图片不显示（正文的图片净化只放行 `poietica-asset:`，未把相对地址改写成 `workspace-file` 地址）；子代理 / 辅助对话的正文没有 `fileScope`，文件链接按当前前台的对话与工作区解析；资源协议按 `files.locate` 交回的字面路径读字节（解开链接后已校验，但校验与读取之间换掉链接不防，本机威胁模型下接受）；`isInside` 在 Linux / macOS 上也按小写比较（大小写敏感的文件系统上会把 `/A` 当成 `/a`，桌面端只发 Windows 故未改） | R-50 |

## 偏差与裁决

外部代码 / 文档按下表编号引用这里（编号是历史编号，**不要重排**）。

| 编号 | 内容 | 理由 / 现状 |
|---|---|---|
| 偏差 #7 | **不设状态栏**：栅格为三行，删掉 06 页 §6.2 的 StatusBar 行；Core 状态改到设置「关于」页。`builtinPoints.statusItems` 的定义保留（无宿主） | 用户 2026-10-05：「删除状态栏的设计」。06 页布局图、03 页 §4、13 页 P3 手册与本条不一致 —— 按用户决定执行 |
| 偏差 #17 | 给测试文件一个**往上找得到、且包含它**的 tsconfig 工程（`packages/`、`features/`、`apps/` 各放一个，extends 根 `tsconfig.tests.json`） | `tooling/tsconfig/*` 一律 exclude 测试，编辑器落到 inferred project 后每个 `bun:test` import 都报 TS2307。闸门是 `tooling/checks/editor-project-map.ts` |
| 偏差 #74 | 工作区选择器不成一条 `sidebarSections`，仍以「会话列表里的组头」出现（07 页 §3E 的表述与产品裁决冲突）；`workspaces.rename` 空名改抛 `kernel.invalid_params` | 产品负责人 2026-10-05/06 的裁决 + 基准截图 #02。设置页也不再单列「工作区」一格 |
| 偏差 23 | 「查看 SKILL.md」落成右坞面板：conversation 定义 `SkillDocumentToken` 并在**第一次打开时**贡献 `location: 'right'` 的面板 | 新架构 `panels` 贡献项没有动态参数，「看的是哪一份」只能悬在服务上；面板标签名固定 |
| 偏差 #49 | 删掉 conversation `threadHeaderItems` 的「N 个文件改动」按钮（含悬停气泡） | 产品负责人 2026-10-07：「删除这个 ui」。打开审查面板改由 `review.openChanges` 与右坞启动器承担 |
| 偏差 #50 | 删掉「累计 token 与费用」按钮、`usage.thread`、`usage.updated`、`ThreadUsage`；`usage.messageCount` 口径改为「用户发出去的句子数」（新表 `usage_messages`） | 产品负责人 2026-10-07：「删除这个，删除干净」。口径差一个数量级（一次输入引出多次采样），契约形状未变 |
| V-01 | 吉祥物运行时按上游逐字迁移：`engine-runtime` 5 个文件保留 `var`、分号与高复杂度函数 | 逐字等价优先于套本仓风格。两条 biome 例外（`noInnerDeclarations` 关闭、`noExcessiveCognitiveComplexity` 80）写在 `biome.json` 的 `overrides`，原因见 `engine-runtime/README.md` |
| R-01 | 排队条两枚按钮仍只画在**最后一行** | 底层已支持任意一行；「每行都加按钮」是产品选择，报告明确不在范围 |
| R-04 | `onCoreLost` 的同步语义依赖「先广播状态、再拉起子进程」；看护人若改成并行启动需重新核对 | `CoreSupervisor` 实现保证 |
| R-07 | ~~草稿引用的同步放在 **attachments 的 UI**，不是 conversation 的 UI~~ | **已收回（分层审查 2026-10-19）**：当初的环是方向错了而不是报告错了——attachments 的 UI 实现 conversation ui-api 里定义的入库口，与 Core 侧方向相反。现在 attachments 只交自己的 `AttachmentsUiToken`（入库 + `trackDraftRefs`），conversation → attachments 与 Core 同向，同步回到报告 §3.4 的接法；方向由 `tooling/depcruise/feature-tiers.json` 钉住 |
| R-08 | 保留 `onEvent` / `hasThreadState` 两个单测观察口 | 删掉要改写 `conversation-core.test.ts` 喂事件的用例，超出任务范围 |
| R-09 | `auto_retry_end` 成功不再上屏（12 页 §9.1 原表为起止各一条） | info 级提示一律不上屏；重试成功由紧随其后的正常回复说明 |
| R-10 | 轮终点只由**上屏的段**决定，不算工具结果的落地时刻 | omp 重开会话会合成工具结果（`timestamp: Date.now()`），拿它当终点会把一轮算到重启那一刻 |
| R-12 | 思考不产生任何可展开 UI，历史回放也不显示（`thought-card.tsx` 与相关样式整条移除） | 产品要求；`virtual-lines.tsx` 的 `measured` 档现只剩 `tool-call-panels` 一个消费者 |
| P-07（修订） | 浏览器原生视图给浮层让路改为**显式登记**（`design-system` 的 `overlay-presence`：Dialog / Menu / Select / Tooltip / 横幅 / 通知卡自己登记，包外自绘浮层用 `useOverlayRef` / `useModalOverlay`），删掉 P-07 的 DOM 观察 `overlay-watch.ts` | 分层审查 2026-10-19：DOM 观察依赖 design-system 的内部结构（传送门是 body 直接子节点、弹层是 `[role="dialog"][data-open]`），而且只认对话框——菜单、下拉、提示、context-gauge 面板、灯箱都会被网页盖住。判定在 browser：模态一律让，贴边浮层与视图相交才让（开在对话区的提示不让网页闪）。没做截图占位：要 `browser.capture` 契约与协议升级，等真机观感再定 |
| B-01 | 工具卡判定浏览器调用看「调用形状」而不是解析代码：字符串里出现 `browser.open(` 会被误认 | 卡片仍照常显示代码与输出，信息不丢；测试里写成已知边界 |
| R-13 | 封条挂在这一轮的第一行上；状态行/封条的出现与封口判据照 DSH | 详见 `features/conversation/src/ui/timeline` 的注释与本条历史版本 |
| R-18 | `show_widget` 的 `url` 来源只收 `localhost / 127.0.0.1` 的 http(s)，**拒绝 Poietica 自己的 dev server**（同源） | 组件在独立来源的外壳文档里跑（`poietica-asset://widget/shell-1.html`，自带 CSP）；主窗口 CSP 只加 `frame-src` |
| P-07（外壳补齐） | 外壳自己画的两处浮层也登记：`workbench/parts/toasts.tsx` 的通知卡（钉在右下角，正压浏览器面板那块地）与 `parts/overlays.tsx` 的「N 个功能加载失败」（钉在页头下方）。它们不是 design-system 的控件，P7 只登记了 `design-system` 的 `ToastRegion`，而外壳实际用的是自己那份 `Toasts` | 同一类病：画浮层的一方不登记，原生视图就不知道让路。前者挡住的是最常出现的一类浮层（内核服务的失败提示） |
| R-34 | 用户气泡改为内部滚动（推翻原「一道淡出」的设计） | 嵌套滚轮交给 `data-scrollable` 仲裁；有滚动条就不再叠两端渐隐 |
| R-35 | 「超过 50 行」不虚拟化，改成收成 `.md` 附件 | contenteditable 的虚拟化会拆掉 IME / 选区 / 撤销栈；产品负责人确认 |
| R-38 | 思考行新字改用回复正文的批次波浪淡入（推翻 R-21 的「新字只变颜色不变透明度」）；颜色只有一种，跟 `.timeline-row` 走 | 用户 2026-10-18：思考一行两种颜色、出字像逐字。墨迹（`--cp-ticker-ink` 450ms 冷却）在快模型下半行都是亮墨，且思考轨道写死的颜色让悬停时与工具行不同步。节奏改由 `@poietica/design-system/wave` 的 `planWave` 一处产出：放得下时与正文同样成段；放不下（在滚）时进轨道的粒度须 ≤ 滑行余量（tail − 设定值 ≈ 1.5em），故仍由 `ticker-pace` 匀速放字，同一 `stepMs` 内的字并成一段淡入（纯 `planWave` 实测应动未动 84%）。滑行上限改读轨道 `padding-inline-end`，删掉 `TAIL_EM`。沙箱 headless 实测 steady 延迟 p95 ~320→~150ms、sJ90 0.27→0.17；**Windows 真机 `bun run check:ticker` 未跑** |
| R-39 | 对话区三处「两件事差一帧」：一轮结束时跑道收掉与回复操作条长出、输入区变高变矮与转录末尾留白、minimap 落点与落定后的校正 | 用户 2026-10-19：回复结束或发完消息后整段对话偶尔抖一下；minimap 跳过去偏下。① 跑道换档（运行行来去）在渲染时就进了 total，行长高却要等 ResizeObserver 下一帧（且这一帧有 scrollToEnd 在途，虚拟器不做同步补偿）→ 先掉 31px 再顶回：换档那次提交在写位置前按 offsetHeight 当场量已渲染的行（`agent-activity-feed.tsx`）。② `useDockClearance` 在 RO 回调里 setState 走默认优先级，留白晚一帧：改 `flushSync`。③ `scrollPaddingStart` 随 `revealing` 撤成 0，scrollend 后虚拟器再校一帧，刚落定的那一轮再上窜一截、钻进页头下的雾（`.conversation-veil`，两行高）：改为常数 = 视口上沿留白（`--cp-gutter`），落点与「滚到顶时第一行」同位。沙箱 headless 实验台（真实 virtualizer + 令牌）逐帧验证；**未在 Electron 真机核对** |
| R-40 | 组件卡片删掉常驻页脚（标题 +「重新运行」）；html 来源的高度只听内容，不再接受 `window.height` | 用户 2026-10-19：组件下面总有空位、鼠标经过还冒出「图标尺寸：…」和重新运行按钮。根因两条：① `.timeline-widget__foot` 常驻 28px（`opacity:0` 只藏视觉、不收起盒子），悬停显形；② html 的 `height` 参数被当成固定窗高（模型随手写 300，内容只有 238），`resize` 还带 `fixed === undefined` 的门槛直接丢弃内容高度。现在 html 只跟内容走，`height` 收窄为 url 专用（描述已改）。**未在 Electron 真机核对**，沙箱用真实外壳 + 真实卡片 CSS 量到 238 → 238 |
| R-41 | 归档**当前所在**的对话时回到入口页；归档别的对话页面不动 | 用户 2026-10-19：停在一个已归档的会话里是自相矛盾的（侧栏没有它的行、主区还开着它）。判据 `leaveForArchive(activeThreadId, threadId)` 住在 `threads/thread-lifecycle.ts`，入参是路由派生的当前会话 —— 与侧栏高亮同一份事实。归档动作从 `contributions.tsx` 的内联实现收进 `actions.archiveThread`，先导航后请求（失败时用户已在入口页，那条对话仍在列表里，不丢东西）。横幅不跳转，仍是可撤销的那一条 |
| R-42 | 会话行的「时间 / 置顶 / 归档」那一格改成不吃时间宽度：时间绝对定位在右缘，格子收到按钮组宽 | 用户 2026-10-19：悬停时置顶图标可以再往左…… 实为反过来的现象 —— 图钉离行右缘还有 13px、左边空出一截。根因是 `.assistant-thread__trail` 是 grid 且两枚子项 `grid-area: 1/1` 共格，格宽取更宽的那个（时间 46.59px > 按钮组 42px），`justify-items: end` 把那点差额全留在左侧：悬停时图钉离右缘 13px、标题到图钉 12.59px。改为时间 `position: absolute; inset-inline-end: 0` 不参与格宽，格宽 46.59 → 42，图钉左移 4.59px 贴到与归档钮同一条右缘（行内边距 8px），静息态时间位置不动。沙箱用真实 `assistant-threads.css` + 真实行高量得：trail 42 / actionsRight 276 / rowRight 284 / gapTitleToPin 8。**同一次反馈的后半段**：置顶还要再往左、两枚之间拉开 —— 两枚按钮的 `gap` 从 2px 改 8px。flex 整组右对齐，间距只往左长：归档右缘不动（276），置顶左移 6px（234 → 228），两枚间隙 2 → 8。**未在 Electron 真机核对** |
| R-43 | 删掉浏览器面板里「按菜单高度垫一块占位」的逻辑（`panel.tsx` 的 `menuHeight` + `bg-muted/30` 块、`overflow-menu.tsx` 的量高 effect） | 用户 2026-10-19：右侧栏「浏览器」打开更多操作后，工具栏下面那条横线莫名其妙亮了。那块占位本意是「菜单打开时让位」，但菜单是 `DropdownMenuContent` 浮层（挂 body、不占布局），占位纯属多余；它自带 `bg-muted/30` 底色与 `border-b`，压在深色面板上就是一条凭空发亮的横线。浮层不需要让位，整条链路删除。回归用例钉 `panel.tsx` 里不再有那块占位（DOM 断言测不到：菜单开合要真实浮层定位，happy-dom 点不出来） |
| R-44 | 三列宽度改为「意图 + 有效几何」两层：`LayoutState` 里的宽度只是意图，画出来的列宽、分隔条范围与无障碍值一律读 `LayoutService.geometry`（`resolveLayoutGeometry`）。边界只剩 ui-kernel 的 `LAYOUT_LIMITS` 一份（侧栏 220–360、右栏 320–800、主列地板 360）；删掉「侧栏收起时右栏上限加回侧栏宽」 | 用户 2026-10-19：两侧拉满 → 收起侧栏右栏还能再拉 → 展开侧栏主区变窄、一拖又跳回。根因是重写时内核按布局图另钳一份 200–480 / 280–900、外壳分隔条按 220–360 / 320–800（+侧栏宽）钳，且窗口宽量了却没人读。让位次序：右栏先缩到下限、侧栏再缩，两侧都在下限才轮到主列地板；窗口放回来意图原样回来 |
| R-45 | 右坞默认宽度 420 → 560（`DEFAULT_PANEL_WIDTH`）；AI 开始驾驶内置浏览器、且浏览器那一格还没在前台时，先把宽度抬到默认值再打开。用户正看着那一格时不动他拖出来的宽度。只抬不收紧，窗口放不下仍由 `resolveLayoutGeometry` 统一让位 | 用户 2026-10-19：AI 自动打开右侧浏览器时宽度太小，网页只剩一条窄页，驾驶过程看不清。旧存盘里的 420 也必须被这条路径抬起来，否则只改默认值对老用户无效；默认 1280 窗口下 560 仍给主列留 440，未越过 `LAYOUT_LIMITS.right` 的 800 上限 |
| R-46 | 右坞开合改为**按归属分账**：`DockPaneSet` 增加 `open`，`auxiliary.owner` 改为派生（前台开着就是前台，收起时保持上一位）；删掉 `setAuxiliaryOwner` / `setPanelActive`，换成 `setDockOpen(owner, open)`。面板贡献加 `scope`（缺省 `surface`，技能文档为 `settings`），`openPane` / `focusPane` 拒收类别不符的格；设置页的坞只画选中那一格，不带标签条、启动器与加号。前台归属唯一写者是 Workbench：表面贡献 `dockOwner(params)`，删掉 `ActiveOwner`。删除对话时 `forgetOwner`；`restore` 不再清空前台、不恢复设置页的开合 | 用户 2026-10-20：在设置页「技能」里唤出的右栏还挂着浏览器、辅助对话、终端等标签，应只看技能。根因是坞只有一个全局 `auxiliary.owner` 槽（在 t2 开坞会收掉 t1 的）、面板没有归属类别（`location:'right'` 在任何归属都出现）、前台归属有 Workbench 与 `<ActiveOwner>` 两个写者；`forgetOwner` 无人调用，`panes.byOwner` 只增不减。**未在 Electron 真机核对** |
| R-47 | 设置的右坞**按页分账**：归属从整个设置共用的 `'settings'` 改为每页一位 `settings:<页 id>`（`settingsDockOwner`）；`PanelScope` 改为 `'surface' \| settings:<页 id>`，技能文档声明 `settingsDockOwner(SKILLS_SETTINGS_PAGE)`，只进「技能」页的坞（`panelAdmits`）。Workbench 用 `useSettingsPageId` 把不带页的设置路由解析成实际落在的那一页再算 `dockOwner`，内容区读同一处。restore 对新旧两种设置归属都不补开合 | 用户 2026-10-20：技能页打开技能文档，退出设置再进来落在缺省的「通用」页，「通用」页右侧仍是技能文档。根因是 R-46 只把设置与对话分开，设置内部所有页共用一位归属，坞开合跟着这一位走、不认页。**未在 Electron 真机核对** |
| R-48 | 右坞「辅助对话」接上 omp 的 `/btw`（协议 41）：引擎端口加 `askSide` / `cancelSide` / `sideTopics` 与 `sideTopic` / `sideDelta` / `sideNotice` 三个事件，`engine-omp` 包 `RpcBtwController`（`session/side-questions.ts`），Core 出 `side.ask` / `side.cancel` / `side.list` 与 `side.topic` / `side.delta` / `side.notice`，UI 由 `composer/side-store.ts` 按线程记话题。**和基准不一致的地方**：① 不调用工具 —— omp 的 btw 本来就把工具挂成「不执行」，答题只用当前上下文的快照；② 去掉占位版的「批准方式 / 计划 / 目标」三枚控件（对一个不跑工具、不写记录的提问没有意义），只留模型与思考档位，且**与主对话共用**（改它就是改主对话的下一轮）；③ fork 会把侧边话题一起复制（omp fork 克隆整个 artifacts 目录），删除会话时一起删；④ 端口的 `isBusy` 语义扩展为「主轮或侧边提问在跑」，thread-service 的删除 / 分叉守卫改读 `state() !== 'idle'`，侧边提问在跑时仍可删除 / 分叉 | 「为什么不在 UI 层拼」：辅助对话需要的是**同一份上下文的旁路采样**，这只有引擎能给（omp 在 `AgentSession` 里取消息快照、单独起一次流），Core 契约此前没有任何通道，所以占位版只能是假控件 + 空 `onSubmit`。基准截图里的那三枚控件需产品确认是否补回；**未在 Electron 真机核对** |
| R-49 | 右坞终端改为**多终端**：终端面板改用 `dockTabs`，每条终端是右坞标签条上的一格（标题「终端」「终端 2」…），面板内的标签条删掉；启动器 / 加号菜单的「终端」与 Ctrl+Shift+` 都是「再开一条」，× 关一条，最后一条关掉时把终端那一格让出去（`watchLastTerminal`：选中挪到同坞最后一格，没有就回启动器）。面板不再挂载即自动开终端，零条时画空态「没有打开的终端」+「新建终端」。终端是全局的（不按对话分），在每个归属的坞里看到的是同一组。**首开闪 #212121 的根因与修法**：终端是右坞唯一 `lazy()` 的面板，首开要等约 420KB 的 xterm 分块，期间 `PanelBody` 的 Suspense 兜底 `PartSkeleton`（`--ui-muted` 40% 叠在 #181818 上 ≈ #212121）顶着，加载完才换成终端底色。改为面板组件静态进首屏、只有 xterm 运行时按需加载（`terminal-loader.ts` 加 `snapshot` / `subscribe`，加载前新建的终端先排队上标签，加载后按同 id 接上）；面板根用 `--terminal-background` 打底；`terminal-pane.css` 随 xterm.css 一起加载以保证覆盖次序。顺带删掉右坞加号菜单的「让位」占位块（同 R-43：`auxiliary-dock.tsx` 的 `menuHeight` + `bg-muted/30`、`auxiliary-menu.tsx` 的量高 effect）——它把面板主体下推一个菜单高，终端每开一次菜单就 refit / PTY resize 两回；标签选中态改为跟随实际画出来的那一格（选中格落空走兜底时，标签条上仍有且只有一格亮着） | 用户 2026-10-20：首次打开右坞终端，背景先显示 #212121 再恢复 #181818；终端要从单终端改为多终端。xterm 仍只经动态 import 加载（P-06 守卫不变）。终端按全局而非按对话分账是沿用现状（PTY 本来就不认对话）；若要按对话分需另行裁决。**未在 Electron 真机核对** |
| 偏差 #80 | 自动起名改成**只在开会话时打开 omp 的开关**：`SessionFactory` 往 `createAgentSession` 传 `autoTitle`（`disableAutoTitle !== true && spec.autoTitle !== false`），删掉 `OmpSessionHost.maybeAutoTitle` 端口、`OmpAgentSessionLike.maybeStartTitleGeneration` 声明与适配器里的「代 omp 触发」。生产语义：首条回复开始流式时 omp 自己起名 | 用户 2026-10-20：对话标题时灵时不灵。真因是 `maybeStartTitleGeneration` **在 omp 18.10.3 / 18.11.1 里根本不存在**（`src` 与 `dist` 均无定义），可选链把调用吞成空操作；而 `createAgentSession` 又没传 `autoTitle`，omp 的 `#noteTitleInput` 第一道门（`config.autoTitle === true`）恒假。库内 47 条线程里 30 条标题与「首句折叠 + 截 60 字」逐字相同。能变成 AI 总结的 16 条全部跑过 `todo op=init` —— omp 还有一条 `title.refreshOnReplan`（默认 true）的重规划刷新。测试夹具自己造了那个方法，所以旧用例 T-AT-1/2 测的是假货；改成直接断言 `createAgentSession` 入参 + 真 omp 冒烟（收到 `sessionTitle: Fix login page styles`） |
| R-50 | 右坞新增「文件」功能 `features/files`（协议 45，插件级）：文件树格 `files.tree` + 查看器标签组 `files.viewer`（按对话分账，标签图标是 `FileTypeMark`、名是文件名、悬停是相对路径），正文里的文件名可点、在右坞打开。**为它动到的地基**：① 审查私有的变更树下沉为 design-system 的 `tree/`（`FileTree` / `pathTreeRows` / `treeKeyEffect`，role=tree 与漫游 tabindex），review 改用它、删 `change-tree.ts`（插件之间不能互相依赖，复用只能下沉）；② 正文认本地文件引用：链接目标与行内代码里的路径改写成 `poietica-file:`，由 `FileLink` 画（带 Material 文件图标、统一链接色）；点击经 conversation 新贡献点 `fileReferenceOpeners` 交给 files，**没有接手方时画成不可点**，不退回 `shell.openPath`（模型写下的路径不该一点就执行）；③ 工作区文件的读取与路径边界只在 files 的 Core 一处（字面 + 解开符号链接两道关），图片字节走 Host 资源协议、每次经 Core 校验；④「当前工作区」改为跟着路由派生（`conversation/ui/setup/workspace-follow.ts`），`openThread` 不再命令式写，恢复路由、后退 / 前进也一致。**顺手修的**：review 监听改为按 workspaceId 计数、单一通知出口，`workspaceRemoved` 时停掉，`git.unwatch` 不再问路径、不再吞错；UI 在 Core 换世后重发 `git.watch`（`review/ui/core-session.ts`）；fs-kit `isInside` 不再把 `..foo` 当成越界；右坞标签支持 `hint`（悬停提示）；workspaces `setActive` 的 `touch` 失败改为记日志 | 用户 2026-10-22：对标 Codex 的右坞文件面板，文件图标必须用项目内联的 Material Icon Theme（lucide 只用于按钮与面板图标）；默认只读预览 + 用默认应用打开，树根是当前对话的工作区。**未在 Electron 真机核对** |
| R-51 | 右坞「文件」第二轮（R-50 之上）：① 查看器工具条删掉「复制路径」「在资源管理器中显示」「用默认应用打开」，连带删 `FileShell`、`shell.openPath` / `shell.showInFolder` 的调用、可执行类型黑名单 `opensAsProgram`（零引用）与 files 对 platform 的依赖；`open-policy.ts` 只剩相对路径拼接，改名 `relative-path.ts`。② Markdown 的「查看源码」图标键换成技能文档面板的 Preview / Source 开关：那组按钮原是 extensions 私有（`skill-doc__modes`），插件之间不能互相依赖，下沉为 design-system 的 `ViewSwitch`（样式逐条照搬），两处共用。③「自动换行」修好：代码视图的行带外面包着一层 `w-max`（max-content），换行时行宽永远等于最长一行，`whitespace-pre-wrap` 折不下来；换行时改为随滚动口宽。④ 正文里的文件链接平时不画虚线，悬停才画（普通网页链接不变）。⑤ `FileTree` 虚拟化（`@tanstack/react-virtual`，与 `DiffBody` 同一个虚拟器，行高固定 28px 不逐行量）：树自己是滚动口（虚拟器要在挂载那次提交里拿到滚动元素，祖先 ref 那时未挂）；行不全在 DOM 里，靠 `aria-setsize` / `aria-posinset` 自报位置；漫游焦点那一行经 `rangeExtractor` 常驻渲染，方向键 / Home / End 先 `scrollToIndex` 再在行挂上后给焦点；新增 `revealKey` / `onRevealed`，「在树中定位」与正文里点目录会滚到那一行（`FileTreeModel.revealTarget` 记账，树挂载晚于 reveal 也接得住）。审查的变更树同步改为把滚动口交给 `FileTree` | 用户 2026-10-22：AI 回复里的文件链接悬浮才出虚线；删三个按钮；查看源码改用 skill 原文的 Preview / Source 开关；修自动换行；树加虚拟化、用最现代的做法。**未在 Electron 真机核对** |
| R-52 | 修 design-system `DiffBody` 虚拟化（> 500 行）挂载即空白：滚动口是消费方的祖先，它的 ref 在子组件 layout effect 之后才挂，虚拟器与原点量测在挂载那一遍都读到 null，要等一次外来的重渲（着色换了一份行、拖宽面板）才画行 —— 查看器里认不出语言、不着色的长文件（`bun.lock`、`LICENSE`）打开就是一片空白；改为挂载后经被动 effect 把滚动口取进 state 再渲一遍（审查、工具抽屉同受益）；新增 `diff/__tests__/surface-virtual.test.tsx` 钉住（旧代码渲出 0 行） | 用户 2026-10-22：bun.lock / LICENSE 打开空白、拖一下界面才显示。**未在 Electron 真机核对** |

## 历史条目索引

每行只有一句话：内容已被代码与提交说明吸收。需要细节时按标题 `git log -S'<标题>' -- docs/refactor-log.md`
取旧版本。

| 条目 | 日期 | 一句话 |
|---|---|---|
| R-01 | 2026-10-09 | 排队 / 插话链路：附件丢失、撤回错条、换层丢内容、认领表泄漏 |
| R-02 | 2026-10-09 | omp 事件泵静默吞异常：投影异常曾让会话永远停在 running（行级故障隔离） |
| R-03 | 2026-10-09 | 会话池生命周期：打开中的会话无人管、配置变更漏网、删除后残留 |
| R-04 | 2026-10-09 | Core 重启 / 页面重载后 UI 不同步：时间线冻结、运行态卡死 |
| R-05 | 2026-10-09 | Core 进程内存与关停：登记只增不减、关停预算、看护人启动竞态 |
| R-06 | 2026-10-09 | 定时任务：提交未送达时运行永不结束，任务从此不再被调度 |
| R-07 | 2026-10-09 | 附件引用登记三缺口：草稿过夜失效、未送达提交不受保护、分支不继承 |
| R-08 | 2026-10-10 | 细枝末节 16 条（`dataTooNew` / `startFailed` 退出码、终端重放序号、附件回收竞态） |
| R-09 | 2026-10-10 | omp 提示按级别上屏：info 不再画成报错 |
| R-10 | 2026-10-10 | 封条「已处理 N」算错：重启后每轮都不一样 |
| R-11 | 2026-10-10 | 工具卡 diff 退化成裸行 → diff 管线整体提升到 design-system |
| R-12 | 2026-10-10 | 时间线过程分组：read / execute / 思考合成一条记事 |
| R-10（审查页） | 2026-10-10 | 目标栏的暂停 / 继续 / 改正文真正下到引擎 |
| R-11（审查页） | 2026-10-10 | 目标模式宿主职责：续跑、重开接回、完成收尾（用 omp 的 `RpcGoalController`） |
| R-13 | 2026-10-10 | agent 展示图片走正式工具 `show_image` |
| R-14 | 2026-10-10 | 自动化 Core：一次性计划、续用对话、超时、通知判定、错过补跑 |
| R-15 | 2026-10-10 | 自动化 agent 工具 8 张 + 选工作区与模型 + 运行中禁止自我繁殖 |
| R-16 | 2026-10-11 | 自动化界面：工具卡重做、模型与思考选择、一次性计划、运行方式、通知 |
| R-16 追加 | 2026-10-13 | 自动化列表卡片去掉「上次运行的结论」 |
| R-17 | 2026-10-11 | Mermaid 图从固定画布改成随栏宽自适应 |
| R-18 | 2026-10-11 | 对话内组件 `show_widget`：沙箱外壳 + 自己的 CSP，跟随主题、回传操作 |
| R-12（审查页） | 2026-10-11 | 排队条插话 / 撤回无反应：入口页建的队列把键关在闭包里 |
| R-13 | 2026-10-15 | 复刻 DSH 的运行状态行与封条：何时出现、何时封、何时不封 |
| R-13 补修 | 2026-10-15 | 进程中途没了的那一轮报「已停止」而非「已完成」 |
| R-19 | 2026-10-12 | 手动添加的模型服务商不生效（入口页仍报「还没有配置任何模型服务商」） |
| R-19 | 2026-10-16 | 四个启动 / 附件现象：气泡丢图、深色闪白、侧栏跳变、恢复后控件不画 |
| R-20 | 2026-10-12 | 思考行划动与换句：遮罩坐标错、按行取句、每批 token 一抽 |
| R-20 | 2026-10-16 | 两个现象：「提交未完成」横幅误报、内置浏览器 / eval 报 same-realm |
| R-21 | 2026-10-12 | 思考行动画 v2：无遮罩的显示屏式滚动 |
| R-21 | 2026-10-16 | 压缩上下文：前文消失、卡在「正在压缩上下文…」、两种长相 |
| R-22 | 2026-10-16 | minimap 鼠标移出时闪现「未命名轮次」 |
| R-23 | 2026-10-16 | 封条：跑着时插的话重开后拆成新一轮、多出一张封条 |
| R-24 | 2026-10-16 | 模型显示开关：关掉的模型仍在菜单里，且要当场生效 |
| R-25 | 2026-10-16 | 后台任务的完成通知被画成了助手正文 |
| R-27 | 2026-10-16 | 时间线帧号：增量与历史两条投影对同一段话给出不同的号 |
| R-28 | 2026-10-16 | `CoreSupervisor` 拉起失败自愈：不再停在 `starting` |
| R-29 | 2026-10-16 | core-kernel 启动途中被叫停：关停不与启动交错 |
| R-30 | 2026-10-16 | 分叉按轮号截断，截断落盘（协议 19） |
| R-31 | 2026-10-16 | 开着的那一轮只有一个产地：整页里换上实时版本 |
| R-32 | 2026-10-16 | 第二轮「用官方能力替换手搓代码」：`Bun.Archive` 换掉 `tar.exe` + 死代码清单 |
| R-33 | 2026-10-16 | omp 版本号只有一个产地：文档锚点可机检、兜底值改为现读 |
| B-01…B-17 | 2026-10-12 | 浏览器工具卡片与标签面（阶段 0，八项） |
| CI-01 | 2026-10-11 | GitHub Actions 持续全红：短名比较的环境折叠 + 去抖测试赌真实时钟 |
| P-01 | 2026-10-11 | 长对话来回滚动：离屏行被卸载，回来整段重新解析 |
| P-02 | 2026-10-11 | 跑着时最小化再切回卡死：视图通知按帧合并、不可见不渲染 |
| P-03 | 2026-10-11 | 流式正文「批次波浪淡入」改成 Web Animations 钉时刻 |
| P-04 | 2026-10-11 | 长对话流式：引用稳定按通道记账、不可变页只扫一次 |
| P-05 | 2026-10-11 | 工具输出与文本流通道压缩：批内合并、运行中节流、环形缓存预算 |
| P-06 | 2026-10-11 | 首屏入口闭包：公式 / 终端 / 灯箱按需加载 + 安装版走 `poietica-app://` |
| P-07 | 2026-10-11 | 浏览器面板浮层观察：只看应用根之外的传送门 |
| P-08 | 2026-10-11 | 自动总结对话标题：接 omp 的能力到线程行 |
| Q1/Q2 | 2026-10-16 | 词表归 transcript、共享界面下沉 design-system（Q1-A/B/D、Q2-1/2-2） |
| Q1-C | 2026-10-16 | 交互载荷类型化：卡片形状归词表（协议 21） |
| Q1-E | 2026-10-16 | 提问打不开、答过的题组锚不上、三类单问答不了（协议 22） |
| 队列条 | 2026-10-16 | 插话带的图不显示、撤回把图丢了（协议 23） |
| O-01～O-06 | 2026-10-17 | omp 能力利用审查：补入口、删两处与 omp 冲突的本地事实（协议 27） |
| Q1-入口草稿 | 2026-10-17 | 入口页首帧拿到被隐藏模型的兜底、档位与实际发送不一致（协议 28） |
| Q1-二期 | 2026-10-17 | 新对话默认模型 / 档位收敛为一份持久意图（协议 29） |
| U-01 | 2026-10-17 | 斜杠命令面板：输入框行首 `/` 起面板，入口页也能用（协议 30） |
| U-02 | 2026-10-17 | 认证跟着服务商走：账号登录与 API Key 分家（协议 31） |
| U-03 | 2026-10-17 | 模型角色收进「按用途指定」（协议 32） |
| U-04 | 2026-10-18 | 命令结果：能打开控件的直接打开，压缩/交接只留一行（协议 33） |
| U-05 | 2026-10-18 | 自动重试：一行原地计数、上限 5 次、失败才摊开 |
| R-34 | 2026-10-17 | 用户气泡：折叠换成内部滚动，五十行起虚拟化 |
| R-35 | 2026-10-17 | 粘进来的超长纯文字收成 `.md` 附件 |
| R-36 | 2026-10-18 | 状态面板悬浮卡与审查页缓存；审查数据源从 `gh` CLI 换成直连 GitHub API |
| R-37 | 2026-10-18 | 升级安装写不进 core.exe：装成「新 Host + 旧 Core」后 `protocol_mismatch` |
| T-01 | 2026-10-18 | 测试集瘦身与提速：omp 测试运行时开关、宽限期走注入时钟、删 28 条无效用例 |
| A–E | 2026-10-18 | 全面审查修复：线性分帧 / 图片内容寻址 / Core 自写日志 / relay 口令 / 资源协议（协议 34 → 35） |
| F-01 | 2026-10-18 | 存储地基：每类数据的主人、上限、回收路径 |
| 目录整理 | 2026-10-13 | 删死文件、收拢与拆分（只动目录与归属，不改行为） |
| 官方能力替换 | 2026-10-14 | 第一轮替换（含 relay 协议缺 `discardedTabsProtocol`、Ctrl+Z 死键两个真缺陷） |
| MCP 在线目录 | 2026-10-14 | MCP 名单接上 omp 的在线目录（精选 6 条保持原样） |
| 代码审查页 | 2026-10-14 | 按 synara 复刻三栏（事实源原为 `gh` CLI，R-36 已改直连） |
| 吉祥物迁移 | 2026-10-14 | V-01：运行时从上游 JS 迁为 TS（见上表偏差 V-01） |
| 界面瘦身 | 2026-10-18 | 删上下文面板三颗维护钮、命令面板按 `enabled` 过滤 |
| 标题开关 | 2026-10-20 | `autoTitle` 从未交给 omp：首句自动总结一次都没跑过（详见上表偏差 #80） |
| 辅助对话 | 2026-10-21 | 右坞辅助对话从占位接成 omp `/btw`：侧边提问不进记录、不调工具（协议 40 → 41，详见上表偏差 R-48） |
| 多终端 | 2026-10-20 | 右坞终端改为每条一格标签的多终端，修首开闪 #212121（Suspense 灰块等 xterm 分块，详见上表偏差 R-49） |
| 性能方案 P5 | 2026-10-21 | 正文排版（streamdown / remark·rehype / shiki / pele，约 2.4MB）移出首屏入口闭包：`design-system/prose` 改为轻壳、入口页画完后空闲预取，时间线第一次挂载等排版落定；入口守卫加这几条、告警线收到 4.2MB |
| 官方能力替换（第四轮） | 2026-10-22 | 手搓 sha256 / fetch 超时 / RPC 守卫 / 去重换官方能力；按实测零引用删 `message-port`、`onceEvent`、`removeSafe`、`PoieticaMark`、`summarize` 与四处转发 re-export；删装饰性步骤编号与复述注释（详见提交说明） |
