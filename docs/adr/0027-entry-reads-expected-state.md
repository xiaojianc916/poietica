# 0027. 入口用期望态：不建会话就读出、就能改

- 状态：已接受
- 日期：2026-10-01

## 背景

点开新对话，工具条上那几格（模型、思考档位、批准方式、计划、目标）此前要等**整次水合**
才有值：`new_session` 走 `SessionManager.create` → `createAgentSession` → `adopt`，
一路把技能、扩展、上下文文件、MCP、LSP 全量发现跑完，才轮到 `readSelectors(record)`
把那张表交出去。

而那张表里真正属于会话的只有少部分。omp 官方把这件事分成两种寿命（本仓 ADR 0021
已经定过「桥是库，不是 webview 模块」这条前提）：

- **期望态**：住 `Settings`（合并五层配置，不做任何 agent 发现）与目录里
  （`discoverSkills` 扫盘、`loadAllMCPConfigs` 只读配置、`ModelRegistry` 内存读）；
- **会话态**：住会话对象上，是轮次级事实（`readSelectors(record)`）。

「用户配成什么样」是第一类的答案，不需要先造一条会话。此前把它挡在第二类后面，
于是入口那一屏为一个它不需要的答案付了全量发现的钱。

## 决策

### 1. 号当先交出，水合放后台

`new_session` 拆成两步：`SessionManager.create(cwd)` 当场签发号（实测 3.5ms），
`adopt`（含 `createAgentSession`）进后台跑。应答立刻回 `{ sessionId, controls }`，
其中 controls 取自期望态。

在飞的那一趟记在 `hydrating`（外加 `hydratingCwd`，见第 3 条），`settleHydration()`
是唯一的等待点：需要会话对象的命令先等它。失败要能被**之后**的命令看见（号已经交出去了，
静默会变成「会话凭空消失」），所以承诺一直挂着，同时挂一个 catch 免得没人等它时算成
未处理拒绝。

### 2. 判据收在 `entryReadOf` 一处

选择器、技能、MCP 名册三格共用同一条寿命规则：会话在手就读会话对象，否则读期望态。
**刻意不等水合** —— 这三格正是入口要的，等它就等于把水合的钱付在入口上；水合完成时
`adopt` 会推一次 `selectors`，屏幕因此先有值、后精确。

写在三处必然有一处先漂移（AGENTS.md §5「单一分发点」），所以判据收在一个函数里，
分派只转发。

MCP 名册那次握手等待**不**摊进 `entryReadOf`：它只对名册有意义，摊进去会把选择器与
技能一起拖住（`waitForPendingConnections` 会 drain 到所有 pending 握手 settle，一台
连不上的服务器实测能挂 181 秒）。它单独在 `mcpServersOf` 里，且必须有截止时间。

### 3. 水合期间的工作区要用新会话的

号交出去、会话对象还没有，`currentSession()` 这会儿找不到它，读期望态就会退回宿主启动
时的 cwd —— 而新对话可能开在另一个目录上（技能因此会扫错地方）。所以 `hydratingCwd`
记一格补这个缺口，`workspaceOf()` 依次看：会话在手的、水合中的、宿主启动的。

同一原因，`listSessions` / `deleteSession` / `exportSession` / `shareSessionFor` 四条
按会话号工作的命令都要先 `settleHydration()`：新会话的文件要到水合时才落盘
（`SessionManager.create` 只签发号），此时按号找文件必然找不到。

### 4. 两条路只有一个模型注册表

`registryFor()` 供两处共用：期望态那一趟读它，`adopt` 建会话也用它。两条路各建一个
注册表就会补两遍目录，用户改过 `models.yml` 之后还可能读到两份不同的表。

次序与 SDK 自己的嵌入方引导一致（`sdk.ts` 的 `hydrateCredentialScopedModelCaches` +
`refreshInBackground`）：先本地补目录，联网发现放后台。不能 await `refresh()`：它默认
`online-if-uncached`，缓存过了 24h 就当场等网络（实测 585ms 断网 / 10442ms 联网）。
凭据页从注册表自己身上取（构造时就是它的第一格），不再 `discoverAuthStorage` 一遍。

### 5. 会话前用配置，会话后只碰同步 getter

改一格期望态走 `applyExpectedSelection`，它返回这一格是**配置**还是**会话状态**：

- 模型落 `setModelRole('default', ...)`（写角色而不是写死 provider，omp 自己按角色解析）；
- 权限落 `tools.approvalMode`（产品三档 → 上游模式）；
- 计划与目标两格只住会话上，还没有会话就如实报 `'session'` —— 调用方拒绝，不静默当成功
  （静默会让屏幕以为已经改了）。

两格落配置后都要 `flush()`：期待态那一格用的是 `settingsFor()`（`Settings.init` 那一份
可写实例），不 flush 就是「点了没反应」。

### 6. 随包的桥拆成多块，入口只装入口

上面五条让**桥内部**不再为入口白等水合。但还有一笔更早的钱：Bun 启动时要先
把入口那一份读进来、解析完才能执行第一行。此前 35MB 全落在 `poietica-bridge.js`
一个文件里（SDK 的 main/modes 那一片占了大半），入口那一趟因此白等整片编译。

`Bun.build` 的 `splitting: true` 把它拆开：入口降到 0.2MB，重的那片落成独立
chunk，按 `import()` 到用时才加载。实测 spawn→ready 从 ~800ms 掉到 ~615ms，
「点开新对话 → 工具条可点」从 ~970ms 掉到 ~795ms。Tauri 的资源 map 用 glob
把 `chunk-*.js` 与静态资源一并收进安装目录（同层，相对解析不变）。

## 已知代价

- 入口那几格先报「此刻期望值」，水合完成后再由 `adopt` 推一次权威值。模型与权限两格
  两条路读的是同一句话（按构造相等，不需要纠正）；会变的是档位与计划/目标，窗口是一次
  水合的时间。见上一节的两条实测分叉。
- 技能与 MCP 名册在水合完成前读的是**配置层**：技能扫盘、MCP 只报「配了哪几台」，
  连接状态一律如实报 `disconnected`（连上与否要 spawn 子进程，属于连接层）。
- 计划与目标两格在入口只有展示与「起手值」，改动由第一句随 prompt 生效
  （`appliesOnSubmit`）。

## 期望态不等于权威态：两条已实测的分叉

「配置期望值就是精确值」只在模型与权限两格上成立 —— 那两格的当前值确实就是配置本身
（`modelRoles.default`、`tools.approvalMode`），两处读同一句话。另外三格不是：

**档位**。会话的当前档住在会话对象上（`configuredThinkingLevel()`），建会话时要过
`pickInitialThinkingLevel`（sdk.ts:1659）再被 `settleThinking` 收敛一次。全局默认取的是
schema 默认而不是用户配的那一格，且上游认 `auto`、本产品不出这一档。实测
`defaultThinkingLevel: auto` 时：入口曾报 `max`（自行退回最深一档），会话实际是 `high`。
修法是让入口走**收敛会话用的同一条判据**（`thinkingToSettle` + `getDefault`），不另写一份。

**计划**。`plan.defaultOnStartup` 只有 `interactive-mode.ts` 的
`shouldEnterPlanModeOnStartup` 与 `print-mode.ts` 读它 —— 那是官方 TUI/CLI 的入口行为。
桥走 `createAgentSession`，它一个字都不读这个开关（sdk.ts 里 plan 只出现在工具门那三处），
所以开了这个开关，权威态照样是 `off`。实测：入口曾报 `on`，会话是 `off`。
修法是这一格只报会话起手值 `off`，不拿配置当当前值。

两处都由 `src/__tests__/expected-state.test.ts` 钉住（对着真实 home 量过分叉，
变异回旧实现会红）。**模型与权限两格是按构造相等的，不再需要水合去纠正它们**；
需要水合的是「档位落定」与「计划/目标进过没有」这两件会话里的事。

## 参考

- `packages/agent-bridge/src/bridge.ts`（`mintSession` / `settleHydration` /
  `entryReadOf` / `mcpServersOf` / `registryFor` / `selectControl`）
- `packages/agent-bridge/src/expected-state.ts`（期望态的读与写）
- `packages/agent-bridge/src/__tests__/expected-state.test.ts`（两种寿命的判据）
- `tools/agent/prepare-runtime.ts`（`splitting: true` 与它在产物里的形状）
- `apps/desktop/electron-builder.yml`（`chunk-*.js` 的 `files` glob）
- `docs/adr/0020-first-frame-hydration-and-launch-gate.md`（首帧水合与启动门禁）
- `docs/adr/0021-omp-bridge-is-a-library-not-a-webview-module.md`（桥是库）
