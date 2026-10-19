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
| Q39 | 2026-10-10 | 只是「看一眼」历史对话也要冷启动完整 AgentSession：`timeline.subscribe` / `controls.get` 都 acquire（拉起工具与 MCP） | 未决。可选路径：引擎端口加只读 `sessionFiles.readPage(...)`，会话不在池里时 `subscribe` 走它，第一次发送才 acquire。采纳需重审 R-03「先 acquire 再 position」的前提 |
| Q40 | 2026-10-12 | ticker 极快档（≥200 字/秒）仍有可见顿挫：应动未动 41%、sJ90 1.43。正确性不受影响 | 已知局限，不跟踪；真机若明显再让设定值随速度变化 |
| Q41 | 2026-10-12 | 换句的上下刷仍带 260ms 透明度变化；规格给了「翻牌式」可选项 | 未决，等真机观感定 |
| Q43 | 2026-10-14 | `docs/omp-sdk-reference.md` 曾停在 18.5.0（relay 缺陷正是照旧文档核对漏出来的） | **已结清（R-33）**：行号锚点可机检（`check:omp-doc`）。升级 omp 时仍按 AGENTS §11 逐项核对内容 |
| Q44 | 2026-10-14 | MCP 配置四个死键（`bearerTokenEnvVar` / `toolTimeoutMs` / `enabledTools` / `disabledTools`）+ 名称校验与 omp 的 `validateServerName` 错位 | **已结清（2026-10-17）**：死键连同 `startupTimeoutMs` 一起删，改用 omp 认的 `timeout`；名称按 omp 判据在表单本地判；Core 写盘前再用 omp 的校验拦一次 |
| Q45 / Q47 | 2026-10-14 | `features/browser/src/host/relay-protocol.ts` 是 omp 内部协议的**副本**（omp 未导出稳定契约） | **已结清（分层审查 2026-10-19）**：协议移进引擎端口（`packages/engine/src/browser-relay.ts`），与 omp 的对齐由 `engine-omp/src/browser-relay-conformance.ts` 在 `typecheck` 里机检（移入时即查出 `cdpEvent.params` 已漂成 `unknown`）。端口与口令改由引擎自备：`AgentEngine.browserRelay()` → browser 的 Core 模块 `browser.relayEndpoint` → Host；`CoreSupervisor` / `CoreCaller` / 启动参数不再认识 relay |
| Q46 | 2026-10-16 | `runtime-layout/src/core-args.ts` 的 33 行 argv 解析可用 `node:util.parseArgs` 替，但它接受 `--k=v`、报错是英文 `ERR_PARSE_ARGS_*`，而 9 条用例钉的是中文文案与「参数重复」语义 | 未决，属可接受的行为变更，需产品裁决 |
| Q48 | 2026-10-16 | `omp-version.ts` 兜底值写死 `'18.5.0'`，会进 `core.ready` 与 `diagnostics.core` | **已结清（R-33）**：改为现读随包 omp 的 `package.json`，读不到才是 `0.0.0-unknown` |
| Q49 | 2026-10-19 | 分叉标题的序号只在「源名已带后缀」时进一档：同一个对话分叉两次（兄弟分支）会得到两个同名 `X（分支）` | 未决。可选路径：落标题前按同工作区现有标题去重（撞名进一档），或就允许重名。当前实现只做链式分叉的递增，兄弟分支不去重 |

## 其他待办（无编号）

| 日期 | 待办 | 依据 |
|---|---|---|
| 2026-10-12 | `node:sqlite` 的 `setAuthorizer` 用不上：受「一条连接服务多模块」架构限制 | 用官方能力替换（2026-10-14）裁决保留 |
| 2026-10-13 | `tooling/checks/ticker-layout/run.ts` 的 `ELECTRON` 常量写死 `node_modules/electron/dist/electron.exe`；改走 `require.resolve('electron')` + `path.txt` 更稳（isolated linker 下前者不成立） | 目录整理 |
| 2026-10-14 | 代码审查页的 Issues 一栏恒为 0（PR 之外不做）；Changes 标签只给统计、不画 diff | 审查页三栏 |
| 2026-10-17 | 自定义服务商的编辑表单读不到原 Base URL 与 API 格式：`ProviderInfo` 不带这两项，`catalog-port.ts` 的 `baseUrl` 恒为 `null`，直接保存会把 Base URL 写成空 | U-02。要补契约字段，建议单独处理 |
| 2026-10-17 | 入口页的选择会改模型页的「默认」标记（同一份意图，收敛的本意）。若产品要「入口页只管这一次」，需另起会话级覆盖 | Q1-二期 |
| 2026-10-18 | `features/review/src/core/__tests__/service.test.ts` 用 `test.skip` 兜底：没有 git 的机器上 19 条静默跳过。改成「缺 git 就红」需拍板 | T-01 |
| 2026-10-18 | `packages/engine-omp/src/ports/__tests__/{mcp,skills,draft-controls}.test.ts` 整目录单跑互相干扰（`omp-home` 夹具的进程级共享状态）：`bun test packages/engine-omp/src/ports` 现在仍 3 fail，单文件全过 | R-19（2026-10-12）/ T-01 |
| 2026-10-18 | `features/platform/src/ui/__tests__/format-bytes.test.ts` 测的是 design-system 的 `formatBytes`，位置不对；挪它要动 `editor-project-map` 闸门的收录范围 | T-01 |
| 2026-10-18 | `RING_MAX_CHARS` 仍为 8MB：没有真机帧大小分布，调小会让长工具输出更早退化成整页重读 | A–E（P-05 的理由） |
| 2026-10-18 | 自动化新线程的保留策略、fork 改为共享前缀、omp gc 的 archive / wal / stale 三段、按时间清理缓存：方案明确不做 | F-01 §7 |
| 2026-10-18 | Windows 真机核对未做：启动 1 分钟后浏览器缓存回落、聊天变大 / Agent 数据变小、删带截图对话后 `session media collected`、`core:build` / `core:probe` 的干净机器验证 | F-01 §6 |
| 2026-10-18 | `enforceBudgets` 的 `clearCache` 返回后立刻量目录，Windows 上删除落盘可能滞后，`freedBytes` 可能偏小（显示「腾出 0 B」）：已知近似 | F-01 §7 |
| 2026-10-18 | `pathKey` 只做 `resolve` + Windows 小写，不做 `realpath` / 8.3 短名归一；junction / 短名场景下 `skip` 集合可能匹配不上而重复计数（构造上本机不触发） | F-01 §7 |
| 2026-10-18 | fork 失败路径两处健壮性：`thread-service` 的 `enqueue` 抛错会覆盖原始 insert 错误；`session-files` 的 `forked.close()` 抛错会跳过 `discard` | F-01 §7 |
| 2026-10-18 | `tooling/checks/review-page/run.ts` 仍自己起 `gh` 取冒烟数据（tooling 不能 import 功能源码，也不在 `bun run all` 里） | R-36 |
| 2026-10-18 | `listProcesses` 每次约 0.5s（PowerShell 起进程开销），启动与关停各一次，未做缓存 | R-37 |

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
| B-01 | 工具卡判定浏览器调用看「调用形状」而不是解析代码：字符串里出现 `browser.open(` 会被误认 | 卡片仍照常显示代码与输出，信息不丢；测试里写成已知边界 |
| R-13 | 封条挂在这一轮的第一行上；状态行/封条的出现与封口判据照 DSH | 详见 `features/conversation/src/ui/timeline` 的注释与本条历史版本 |
| R-18 | `show_widget` 的 `url` 来源只收 `localhost / 127.0.0.1` 的 http(s)，**拒绝 Poietica 自己的 dev server**（同源） | 组件在独立来源的外壳文档里跑（`poietica-asset://widget/shell-1.html`，自带 CSP）；主窗口 CSP 只加 `frame-src` |
| R-34 | 用户气泡改为内部滚动（推翻原「一道淡出」的设计） | 嵌套滚轮交给 `data-scrollable` 仲裁；有滚动条就不再叠两端渐隐 |
| R-35 | 「超过 50 行」不虚拟化，改成收成 `.md` 附件 | contenteditable 的虚拟化会拆掉 IME / 选区 / 撤销栈；产品负责人确认 |
| R-38 | 思考行新字改用回复正文的批次波浪淡入（推翻 R-21 的「新字只变颜色不变透明度」）；颜色只有一种，跟 `.timeline-row` 走 | 用户 2026-10-18：思考一行两种颜色、出字像逐字。墨迹（`--cp-ticker-ink` 450ms 冷却）在快模型下半行都是亮墨，且思考轨道写死的颜色让悬停时与工具行不同步。节奏改由 `@poietica/design-system/wave` 的 `planWave` 一处产出：放得下时与正文同样成段；放不下（在滚）时进轨道的粒度须 ≤ 滑行余量（tail − 设定值 ≈ 1.5em），故仍由 `ticker-pace` 匀速放字，同一 `stepMs` 内的字并成一段淡入（纯 `planWave` 实测应动未动 84%）。滑行上限改读轨道 `padding-inline-end`，删掉 `TAIL_EM`。沙箱 headless 实测 steady 延迟 p95 ~320→~150ms、sJ90 0.27→0.17；**Windows 真机 `bun run check:ticker` 未跑** |
| R-39 | 对话区三处「两件事差一帧」：一轮结束时跑道收掉与回复操作条长出、输入区变高变矮与转录末尾留白、minimap 落点与落定后的校正 | 用户 2026-10-19：回复结束或发完消息后整段对话偶尔抖一下；minimap 跳过去偏下。① 跑道换档（运行行来去）在渲染时就进了 total，行长高却要等 ResizeObserver 下一帧（且这一帧有 scrollToEnd 在途，虚拟器不做同步补偿）→ 先掉 31px 再顶回：换档那次提交在写位置前按 offsetHeight 当场量已渲染的行（`agent-activity-feed.tsx`）。② `useDockClearance` 在 RO 回调里 setState 走默认优先级，留白晚一帧：改 `flushSync`。③ `scrollPaddingStart` 随 `revealing` 撤成 0，scrollend 后虚拟器再校一帧，刚落定的那一轮再上窜一截、钻进页头下的雾（`.conversation-veil`，两行高）：改为常数 = 视口上沿留白（`--cp-gutter`），落点与「滚到顶时第一行」同位。沙箱 headless 实验台（真实 virtualizer + 令牌）逐帧验证；**未在 Electron 真机核对** |
| R-40 | 组件卡片删掉常驻页脚（标题 +「重新运行」）；html 来源的高度只听内容，不再接受 `window.height` | 用户 2026-10-19：组件下面总有空位、鼠标经过还冒出「图标尺寸：…」和重新运行按钮。根因两条：① `.timeline-widget__foot` 常驻 28px（`opacity:0` 只藏视觉、不收起盒子），悬停显形；② html 的 `height` 参数被当成固定窗高（模型随手写 300，内容只有 238），`resize` 还带 `fixed === undefined` 的门槛直接丢弃内容高度。现在 html 只跟内容走，`height` 收窄为 url 专用（描述已改）。**未在 Electron 真机核对**，沙箱用真实外壳 + 真实卡片 CSS 量到 238 → 238 |
| R-41 | 归档**当前所在**的对话时回到入口页；归档别的对话页面不动 | 用户 2026-10-19：停在一个已归档的会话里是自相矛盾的（侧栏没有它的行、主区还开着它）。判据 `leaveForArchive(activeThreadId, threadId)` 住在 `threads/thread-lifecycle.ts`，入参是路由派生的当前会话 —— 与侧栏高亮同一份事实。归档动作从 `contributions.tsx` 的内联实现收进 `actions.archiveThread`，先导航后请求（失败时用户已在入口页，那条对话仍在列表里，不丢东西）。横幅不跳转，仍是可撤销的那一条 |
| R-42 | 会话行的「时间 / 置顶 / 归档」那一格改成不吃时间宽度：时间绝对定位在右缘，格子收到按钮组宽 | 用户 2026-10-19：悬停时置顶图标可以再往左…… 实为反过来的现象 —— 图钉离行右缘还有 13px、左边空出一截。根因是 `.assistant-thread__trail` 是 grid 且两枚子项 `grid-area: 1/1` 共格，格宽取更宽的那个（时间 46.59px > 按钮组 42px），`justify-items: end` 把那点差额全留在左侧：悬停时图钉离右缘 13px、标题到图钉 12.59px。改为时间 `position: absolute; inset-inline-end: 0` 不参与格宽，格宽 46.59 → 42，图钉左移 4.59px 贴到与归档钮同一条右缘（行内边距 8px），静息态时间位置不动。沙箱用真实 `assistant-threads.css` + 真实行高量得：trail 42 / actionsRight 276 / rowRight 284 / gapTitleToPin 8。**同一次反馈的后半段**：置顶还要再往左、两枚之间拉开 —— 两枚按钮的 `gap` 从 2px 改 8px。flex 整组右对齐，间距只往左长：归档右缘不动（276），置顶左移 6px（234 → 228），两枚间隙 2 → 8。**未在 Electron 真机核对** |

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
