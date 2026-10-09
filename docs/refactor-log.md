# 重构日志

## R-01 排队 / 插话链路：附件丢失、撤回错条、换层丢内容、认领表泄漏（2026-10-09）

**来源**：产品负责人交办的缺陷报告 `R-01 排队 插话链路：附件丢失、撤回错条、换层丢内容、认领表泄漏.md`
（外部输入，不入库）。六个缺陷 A–F 共用一条根因：队列项的**身份**与**完整内容**只在
`OmpSession.ledger` 里，而端口没有按项操作、UI 又把 id 丢了。

**改法**（严格按报告 §3 的设计）：

1. **投递正文唯一产地**：`prompt.ts` 新增 `wireTextOf()`（原文 + 每个文件一行 `@绝对路径`），
   `preparePrompt` 与 adapter 的 `host.steer` 共用它。排队 / 插话从此**不再丢文件**（缺陷 A）。
2. **按项操作**：`OmpSessionHost` 删掉 `popLastQueued` / `clearQueue`（清空 + 重投的兜底路径
   **一并删除**，不留），换成 `removeQueued(text, deliverAs)` → omp 的
   `removeQueuedMessage(text, queue)`。撤回不再依赖「最后一条」的假设（缺陷 B、C）。
3. **账本带 id 与完整输入**：`QueueEntry` 扩成 `{id, text, wireText, skill, deliverAs, createdAt, input}`，
   `reconcileQueue` 按 `wireText` 匹配、对不上不丢弃而是搬进 `consumed`；`enqueue` / `moveQueued`
   走同一条 `serial()` 串行链，账本顺序 = omp 队列顺序（缺陷 B 的顺序 / 漏账）。
4. **换层落到服务端**：`EngineSession.moveQueued(queueItemId, deliverAs)` + 契约新增
   `queue.move`（`PROTOCOL_VERSION` 7 → 8）。用账本里的原始输入重新入队，图片 / 文件 / 技能
   全保留；Core 用 `pool.peek`（不开冷会话），`queue.withdraw` 同样改成 `peek`。
5. **认领有生命周期**：`injected: string[]` → `consumed: QueueEntry[]` + `ownPrompt`。
   本轮自己的 prompt 按 `wireText` 排除；会话回到 idle 时两格全清（abort 丢弃的队列项也在
   这里作废）；`message_start` 与 `queue_update` 两种到达顺序都只画一次（缺陷 F 的重复气泡）。
6. **技能插话上屏**：`isUserSkillMessage()` 从 `projector/history.ts` 搬到 `prompt.ts`（只有一份），
   `handleOmpEvent` 的 `message_start` 同时认 `role === 'user'` 与用户技能消息（缺陷 F 的后半）。
7. **UI 保留 id**：`QueuedMessages.steering/followUp` 从 `string[]` 改成 `QueuedItem[]`，
   `AgentSessionPort.withdraw(itemId)` 按号点名，新增 `move(itemId, deliverAs)`；
   `prompt-queue` 换层改调 `queue.move`，**不再撤回 + 重新提交**（缺陷 D、E）。

**必须实测的一条（报告 §3.4 的 aside）**：技能插话在 omp 的 `getQueuedMessages()` /
`queue_update` 里报的是不是 `queueChipText`。结论：**是**。依据 `@oh-my-pi/pi-coding-agent@18.5.0`
的源码（`packages/engine-omp/node_modules/.../src/session/agent-session.ts`）：

- `#queueCustomMessage` 在 `options.queueChipText !== undefined` 时把它写进
  `details.__queueChipText`（第 8213 行附近）；
- `getQueuedMessages()` → `.map(queueChipText)`（第 8591 行），而
  `queued-messages.ts` 的 `queueChipText(message)` 对 `role === "custom"` **先读**
  `readQueueChipText(message.details)`、读不到才退回正文（第 100 行附近）；
- `removeQueuedMessage(text, queue)` 的匹配器 `#findQueuedUserMessage` 先比「原始提交正文」
  再比 `queueChipText`（第 8634 / 8672 行附近），两条都能命中。

因此技能分支的 `wireText` 取 `submit.text`（= 我们传的 `queueChipText`）：对账、撤回、
认领三处同一份字符串。普通 steer / followUp 的 `message_start` 正文也等于 `prepared.text`
（omp 只在有 prompt template 时改写；`@路径` 原样保留，`expandPromptTemplate` 对非 `/` 开头的
文本是恒等函数）—— 这一点由新的 `queue.test.ts` 用真适配器钉住。

**测试**：

- `packages/engine-omp/src/__tests__/queue.test.ts`：Q1–Q10 十条（文件附件、撤回中间项、
  撤回 steer 不动 followUp、技能换层、撤回后重发只画一次、技能插话上屏、两种事件顺序、
  已消费项抛 `engine.queue_item_consumed` 且仍上屏、串行顺序、abort 后同文不重画），
  外加 Q1b：带文件的插话按 `wireText`（含 `@路径`）认领、屏幕上画的是用户原文。
- `packages/engine-testkit/src/conformance.ts`：`C-QUEUE-MOVE`、`C-QUEUE-WITHDRAW-MISSING`
  （FakeEngine 与 OmpEngine 两个实现都要过）。
- `features/conversation/src/core/__tests__/conversation-core.test.ts`：`queue.move` 换层，
  以及无活会话时 `withdraw` / `move` 抛 `kernel.not_found` 且 `engine.opened` 长度为 0。
- `features/conversation/src/ui/components/__tests__/prompt-queue.test.tsx`、
  `ui/stores/__tests__/session-port.test.ts`：UI 按号撤回 / 换层。

**本轮偏差**（记入偏差表）：`prompt-queue` 的撤回 / 换层两枚按钮仍然只画在**最后一行**。
底层现在支持任意一行，但「每行都加按钮」是产品选择、报告 §3.8 明确不在本页范围
（“按钮的位置与样式不动”），所以保持原样，只把语义改成「操作它所在的那一行」。

## R-02 omp 事件泵静默吞异常：一次投影异常就能让会话永远停在 running（2026-10-09）

**来源**：产品负责人交办的缺陷报告 `R-02 omp 事件泵静默吞异常：一次投影异常就能让会话永远停在 running`
（外部输入，不入库）。按报告 **v2** 的「行级故障隔离」方案执行（第一版的「投影失败就整页重取」已作废）。

**现状**：`handleOmpEvent` 的整个 switch 包在 `try { … } catch { void error }` 里 —— 全仓唯一一处
吞异常的写法（`rg "void error"` 只有它）。吞掉的恰恰是 adapter 与 OmpSession 自己抛出的异常，
而 `session.emit` 早就在 `Emitter.fire` 里隔离了监听者的异常。实际可能抛异常的地方逐个核对过：
旁路调用（`message_end` 的 `emitUsageFrom` / `reportContextUsage`、`queue_update` 的 `reconcileQueue`、
`model_changed` 这类事件的 `controlsChanged`）、参数提取（`String(event.toolCallId)` 遇到无原型对象
抛 TypeError）、投影器（`toolEnd` 的 `isError` 分支读 `result.content` 的 getter）、收尾
（`agent_end` → `finishTurn` → `lastAssistant()`）。

**修法**（严格按报告 §2 的设计）：

1. **新文件 `packages/engine-omp/src/event-faults.ts`**：`EventFaults`（同一轮同一事件类型只 warn 一次、
   其余计数、轮终汇总一条，然后清零）+ `describeError`（非 Error 且连字符串化都抛也有兜底）。
2. **`LiveProjector` 两个新方法**：`toolFallback`（工具事件失败时就地降级那一格 —— 已 start 过的格沿用
   同一个 `tool.<id>` 并带回 `input`，没 start 过的先封掉正在流的正文再登记；状态照实写），
   `abandonTurn`（只复位累加器、不产出 op）。`turnEnd` 末尾的复位段改成直接调 `abandonTurn`，
   两处不再各写一份（P4 用「各跑一遍再逐字段比对产出」钉住这条）。
   报告 §2.5 要求核对的 `output` 形状已确认：降级帧用 omp 工具结果那套
   `{ content: [{ type: 'text', text }] }`，`features/conversation/src/ui/components/semantics/tool-call-facets.ts`
   的 `outputOf()` 正是按 `Reflect.get(value, 'content')` 取 text 块拼 markdown（`ompToolView` 的
   `failOr` 也会用 `frame.error` 兜住 error 那一档），**形状无需替换**。
3. **adapter 拆成三层**：`dispatchOmpEvent`（原 switch 原样搬进去，去掉 `agent_end`）、
   `handleOmpEvent`（只看 `event.type` 字符串分流：`agent_end` 走 `endTurn`，工具类失败时 `degradeTool`，
   其余只记日志）、`endTurn`（`finishTurn` 与 `reportContextUsage` 各自兜住、互不连累，最后 `settle()`）。
   签名从三个位置参数换成 `EventPump` 对象，`ledger` 不再进函数（它只给子 agent 总线那两条订阅用）。
4. **`OmpSession` 收尾一定发生**：新 `settleTurn` 按 ① `turnEnd`（尽力而为）→ ② `abandonTurn`（finally）
   → ③ `setState('idle', error)`（finally；有待答交互时改记 `endedWithPending`）的顺序收口，
   三步顺序不能换（idle 一发出，订阅方就可能在同一调用栈里投递下一条排队消息）。
   `finishTurn` 读不到结局按 `completed` 收（`agent_end` 本身就是 omp 的正常结束信号，标成 failed
   会让定时任务记一次假失败），并加了幂等短路（轮已关 + 状态已 idle 时直接 return）。
   `onPendingCountChanged` 在待答数归零且 `endedWithPending` 非空时**先**收成 idle 再 return，
   不再走原来切回 running 那一支；`submit` 开新轮、`cancel` 两处各自清掉这个标记。
5. **明确不做**：不给投影器每个方法各自加 try；不把异常做成屏幕上的 notice 帧；
   不在开着轮时发 `timelineReset`（增量与整页的编号规则不同，会演成每来一个 token 整页读一次的刷新风暴）。

**执行步骤 1 的反向验证**（按报告 §3 第 1 步）：把 `omp-session-adapter.ts` / `session.ts` / `projector/live.ts`
临时换回 `HEAD` 版本（只给 live.ts 补上 `TOOL_FALLBACK_TEXT` 常量让测试能编译），跑新用例：
**E1–E10 里 E8 通过、其余 10 条全红**。与报告 §4 的预期相比只差 E3：报告标「通过（回归）」，
实际旧代码上也红了 —— 两个 `agent_end` 都在抛异常的那一支上卡住，轮头与累加器都没收干净，
后一轮的号与插话因此对不上（正是报告 §2.7「收尾一定发生」要防的东西）。按实测记下。
恢复修好的代码后 11/11 全绿。

**测试**：

- `packages/engine-omp/src/__tests__/event-pump.test.ts`：E1–E10 + E5b 十一条，每条都额外断言
  **没有发出任何 `timelineReset`**（E0）。被测对象是真的适配器 + 真的 `OmpSession` + 真的 `EventFaults`，
  只把 omp 的 AgentSession 换成假会话（搭法同 R-01 的 `queue.test.ts`），logger 用记录型。
- `packages/engine-omp/src/projector/__tests__/live.test.ts`：P1–P4 追加用例（同一 frameId 与 input 的沿用、
  封流后另起一帧、没开轮时返回空、`abandonTurn` 之后 `steeredFrame` 退回 `userTurn`、
  `turnEnd` 与 `abandonTurn` 的复位逐字段一致）。

**验收**：`bun run check` 全绿（1548 pass / 0 fail，201 文件 / 5057 断言）。报告 §5 的四条 grep 全过：
`rg "void error" packages features apps` 无命中；`rg "timelineReset\(" packages/engine-omp/src` 只剩
`auto_compaction_end` 那一处加 `session.ts` 的定义；`recoverFromProjectionFailure|recoveredThisRun` 无命中。

**未在本项范围、记入待决**：`auto_compaction_end` 原有的 `timelineReset('main')` 保持不动。
若它在开着轮时触发，同样会有 §2.2 说的编号问题；omp 什么时候发这条事件需要读 omp 源码确认，
本项没有核实，执行者不处理（报告 §2.8 明说）。

**本轮偏差**：无（三条改动全部落在报告许可的文件里，未动契约、未提 `PROTOCOL_VERSION`）。

### 审查执行待决（R-02 新增）

| 编号 | 日期 | 问题 | 阻塞的步骤 | 状态 |
|---|---|---|---|---|
| Q33 | 2026-10-09 | `auto_compaction_end` 的 `timelineReset('main')` 会在开着轮时整页重取，与增量投影的编号规则打架（R-02 §2.2 的刷新风暴）。需要先读 omp 源码确认它是否可能在 `agent_end` 之前发出，再决定改成行级更新还是保留重取 | 无（本项按报告 §2.8 明确不处理） | 记录：按守则 11 不再猜，等产品负责人/方案方裁决 |

## R-03 会话池生命周期：打开中的会话无人管、配置变更漏网、删除后残留、冷打开双倍整读（2026-10-09）

**来源**：产品负责人交办的缺陷报告 `R-03 会话池生命周期：打开中的会话无人管、配置变更漏网、删除后残留、冷打开双倍整读`
（外部输入，不入库）。六个缺陷 A–F 共用一条根因：会话池把「已打开」与「正在打开」放在两张表里，
所有释放类操作只看得到前者，而冷打开一条 omp 会话要几秒 —— 打开窗口里发生的事全部漏掉。

**改法**（严格按报告 §2 的设计，**无契约变更**）：

1. **`session-pool.ts` 重写成槽位状态机**（§2.2）：`slots: Map<string, Slot>`，槽位
   `opening → live →（释放后消失）`，带 `generation` 代号。对外接口保留
   `peek / acquire / release / dispose`，新增 `isOpening`；`releaseIdle` 按语义改名 `invalidate`
   （配置变了 +1 换代：空闲的立刻释放，忙的与打开中的在第一次空闲时释放）。
   `acquire` 的兜底：旧代且空闲 → 先释放再按新配置重开。`dispose` 并发释放所有槽位，且
   打开中的槽位在落地时发现 `disposed` 也走丢弃路径。
2. **释放打开中的槽位 = 取消**：`release` 置 `cancelled` 并等 `open()` 收尾（dispose 完才返回）；
   被取消的打开拒绝为 `kernel.cancelled`，不进 `live`、不调 `onOpened`。`acquire` 落在
   取消中的槽位上时先等它收尾再开新的（拿到的一定不是被取消的那条）。
3. **`onOpened` 抛异常不再漏**：订阅先挂、`onOpened` 放在 try 里，失败就退订、删槽位、
   dispose —— 半绑定的会话不会留在池里被下一次 acquire 命中。
4. **换代靠状态事件收口**：`onSessionEvent` 把事件原样转给路由后，旧代槽位收到 `state=idle`
   就 `queueMicrotask` 释放（microtask 让同一条事件的其它处理先跑完；释放前再核对槽位身份
   与忙碌状态）。`sweep()` 除了 TTL 也把「旧代且空闲」一并释放。
5. **线程删除的统一遗忘钩子**：`ThreadServiceDeps.onThreadRemoved` → 组合根接到
   `router.forget`（新增同时清 `claimed`）与 `submissions.forget`（清 `lanes` / `pendingTurn` /
   `handed` 里的那一个）。`cleanup(row)` 顺序改为「释放会话 → **重读行**拿 sessionFile
   → 删会话文件 → 释放附件 → 删行 → `hub.disposeThread` → `onThreadRemoved`」：打开期间
   `onOpened` 可能刚把 sessionFile 写上，旧 `row` 上的值是 null，不改就会留下孤儿文件。
6. **`#isBusy` 明确「打开中不算忙」**（删除 / fork 允许穿过，由取消语义保证干净）；
   `ThreadServiceDeps` 删掉从来没被调用的 `onSessionReleased` 一格（死接线，R-03 §2.3 未点名，
   但与本项的文件清单一致，且删掉它正好让 `isOpening` 顶上去）。
7. **`SubmissionService.enqueue` 的车道尾巴自收口**：`tail` 结束时核对自己还是不是当前尾巴，
   是就删表 —— 原先每跑过一条线程就永久留一项。新增只读的 `has(threadId)`（router / 池 / 核心
   各一个）供断言。
8. **`handlers.ts` 的 `timeline.subscribe` 先拿会话再取位置**（§2.4）：冷打开会在 `onOpened`
   里换 epoch，必须先发生；`onOpened` 里「已有通道就 resetThread」的逻辑保留（驱逐后重开时，
   其它已订阅的窗口确实要重取）。

**执行步骤 1 的反向验证**（按报告 §3）：新用例在旧代码上跑 —— 会话池 P1/P2/P3/P4/P5/P7 六条全红
（`controlledPool` 的 `openSession` 停在 deferred 上，旧代码的 `opening` 表与 `live` 表分家，
release/dispose 看不见它）；T2 红（旧代码先 `hub.position()` 建通道，冷打开落地时 reset → 发出
`timeline.reset`，实测 `Expected 0, Received 1`）；T3 红。P6 与既有 CV-7 / CV-8 在新旧代码上都绿
（回归判据）。T1 在旧代码上「通过」的形状变了：旧代码 `delete` 不会等打开，断言「被 dispose」
会超时 —— 它验的正是新语义（删除等取消收尾）。

**测试**：

- `core/__tests__/session-pool.test.ts`：P1–P7 七条（打开中 release / dispose / 忙会话换代 /
  打开中换代 / onOpened 抛异常 / 并发与溢出回归 / 取消后立刻 acquire）。
- `core/__tests__/conversation-core.test.ts`：T1（打开中删除：会话被 dispose、无孤儿会话文件）、
  T3（删除后 router 与 submissions 的该线程状态清空）。测试缝 `deferredOpenEngine()` 加在
  `core/__tests__/helpers.ts`（`openSession` 停在手动 resolve 的 deferred 上）。
- `core/__tests__/module.test.ts`：T2（fork 出的历史对话冷订阅：不发 reset，返回 epoch 与
  之后的 `timeline.ops` 一致）。

**验收**：`bun run check` 全绿（1558 pass / 0 fail，201 文件 / 5105 断言）。

**未能核实、记入待决**：报告 §5 的三条真机验收（DevTools 里 subscribe 只出现一次且无 reset、
运行中改 MCP 后这一轮结束新会话生效、删对话后 `%APPDATA%\Poietica\omp\agent\sessions` 不残留）
需要打包后的桌面应用与真实 omp，本轮没有跑真机，留给产品负责人按 §5 复核。

**本轮偏差**：无契约变更、未动 `PROTOCOL_VERSION`；文件清单与报告一致，加了两处测试缝
（`helpers.ts` 的 `deferredOpenEngine` 与三个 `has(threadId)` 只读断言口）。

### 审查执行待决（R-03 新增）

| 编号 | 日期 | 问题 | 阻塞的步骤 | 状态 |
|---|---|---|---|---|
| Q34 | 2026-10-09 | R-03 §5 的三条真机验收未跑（需要安装包 + 真 omp）：① 打开旧对话时 `timeline.subscribe` 只出现一次、无 `timeline.reset`；② 运行中启用 MCP，这一轮结束后再发一句能用上新 MCP；③ 发第一句后立刻删对话，会话目录不残留 | 无（代码与单测已按报告落地） | 记录：等产品负责人真机复核 |

## R-05 Core 进程内存与关停：引擎会话登记只增不减、关停预算不一致、看护人启动竞态（2026-10-09）

**来源**：产品负责人交办的缺陷报告 `R-05 Core 进程内存与关停：引擎会话登记只增不减、关停预算不一致、看护人启动竞态`
（外部输入，不入库）。三项共用一条主线：谁释放资源、什么时候算过点，散在四个位置各写各的。

**改法**（严格按报告 §3 的设计，**无契约变更**）：

1. **引擎：释放即注销**（§3.1）。`OmpEngine.openSession` 在 `createSession` 落地后复查
   `disposed`：已关就当场 `dispose()` 并以 `kernel.cancelled` 拒绝。新增私有 `track(session)`：
   登记进 `sessions` 的同时包一层 `dispose`（`Object.assign`，与 `create-engine.ts` 包 MCP
   存活表的风格一致），幂等且无论谁调用都从登记表摘除。`dispose()` 改并发
   （`Promise.all`）并对已经关过的会话不重复关。只读断言口 `liveSessionCount()` 标了
   「仅测试使用」。**同一处顺手核对 `engine-testkit/src/fake-engine.ts`**：它有同样的
   「只增」集合（报告 §3.1 要求检查），按同一规矩包了一层 —— 不修的话替身会替真实现遮错。
2. **时间线缓存随会话释放清空**（§3.2）。`TimelineChannel.dropHistory()`：`flush()` 后
   `ring.length = 0`，**不换 epoch、不重置 seq、不发 reset**；`TimelineHub.dropHistory(threadId)`
   遍历该线程所有通道；`ThreadService.onReleased` 先清缓存再重报行。
   为什么不能 `reset`：那会让 UI 立刻整读，而 R-03 之后整读会 acquire 会话 —— 刚驱逐就被
   重新打开。缓存空时 `catchUp` 本来就返回 `complete:false`，`catchUp` 一行未动。
3. **关停预算：共享常量 + 总截止时间**（§3.3）。`@poietica/runtime-layout` 新增
   `CORE_SHUTDOWN_BUDGET_MS = 8_000`（Host 与 Core 都依赖它）。`core-kernel/kernel.ts`
   的 `shutdown` 先算 `deadline`，每个阶段用 `remaining(cap)` 取「剩余预算和这一阶段上限
   的较小值」：排空 3 秒 → **1.5 秒**；模块钩子仍按逆拓扑序串行，每个 `min(5s, 剩余)`，
   剩余为 0 时**跳过并 warn**；`engine.dispose` 给 `max(1s, 剩余)`；`db.close()` 与
   `peer.dispose()` 移进 `finally`，无论上面成败都执行。计时改走**注入的 Clock**（新加
   文件内私有 `withClockTimeout`）：生产里它就是 `systemClock`，而测试注入假时钟后再
   不受真实 5 秒/10 秒约束 —— 旧代码那条「真实时钟 5 秒」的 K-7 用例改成推假钟。
   `core-supervisor` 的 `STOP_GRACE_MS = CORE_SHUTDOWN_BUDGET_MS + 2_000`（10 秒）。
4. **看护人：每个 await 之后复查代际**（§3.4）。新增 `private stale(gen)`（`idle` 也算过期：
   `restart()` 先置 idle 再 `start()`，而 `start()` 立刻 `starting` 并在 `launch` 里
   `++generation`，新一代不会被误判）；`launch()` 在 `pickPort` 落地后先 `stale` 复查再
   spawn；ready 超时分支与成功分支都改成「过期也先 `killChild` 自己那一代」。新增
   `killChild`：只杀「pid 有、`exitCode === null`」的 child。`restart()` 在置 idle 之前
   先收掉 `restartTimer`。`onExit` 的代际检查原样保留。

**执行步骤 1–4 的反向验证**（按报告「先写失败测试」的守则逐项实测）：把实现临时换回 `HEAD`
版本跑新用例 —— M1/M2 全红（`liveSessionCount` 不存在；M2 的 `openSession` 拿到了
**永不关闭**的会话而不是 `cancelled`）；M3/M4 全红（方法不存在 / `complete` 仍为 true）；
M5 与 K-7 全红且**各自真的等了 5 秒**（旧代码没有总预算、且计时挂真实时钟）；M6/M7 全红
且各自 **5 秒超时**（幽灵 spawn / 双 Core 就这么来的）；`STOP_GRACE_MS` 断言红。
M8 在新旧代码上都是绿的 —— 与报告标注一致（回归用例）。恢复实现后 24/24 全绿。

**测试**：

- `packages/engine-omp/src/__tests__/engine.test.ts`：M1（open 3 → dispose 2 → 中间态 1、
  原始 dispose 各恰一次）、M2（`openSession` 与 `dispose` 赛跑）。
- `features/conversation/src/core/__tests__/timeline-channel.test.ts`：M3（`dropHistory` 的
  三不：不换 epoch、不重置 seq、不通知）+ hub 按线程清；`conversation-core.test.ts`：M4
  （真走一次 release，`catchUp.complete === false`）。
- `packages/core-kernel/src/__tests__/kernel.test.ts`：M5（假时钟推进；断言总耗时 ≤ 预算+1s、
  gamma/beta 被放弃而 alpha 被**跳过**、engine.dispose 被调、`db.close()` 用「Windows 上
  没关的 SQLite 文件删不掉（EBUSY）」实证）。
- `packages/host-kernel/src/__tests__/core-supervisor.test.ts`：M6、M7、M8 与
  `STOP_GRACE_MS = CORE_SHUTDOWN_BUDGET_MS + 2000`。
- `packages/runtime-layout/src/__tests__/core-launch.test.ts`：`CORE_SHUTDOWN_BUDGET_MS` 的值。

**验收**：`bun run check` 全绿（1569 pass / 0 fail，201 文件 / 5143 断言；较 R-03 的 1558
多 11 条）。

**未能核实、记入待决**：报告 §6 的两条手工验收需要打包应用 + 真实 omp（任务管理器里
`poietica-core.exe` 内存不再随翻历史线性上涨；一轮正在跑时退出应用，`core.log` 里
`shutting down` 之后各阶段齐全、没有 `core did not exit in time, killing`）。

**本轮偏差**：无契约变更、未动 `PROTOCOL_VERSION`；文件清单与报告 §1 一致（
`engine.ts`、`timeline-{channel,hub}.ts`、`thread-service.ts`、`runtime-layout/*`、
`core-kernel/kernel.ts`、`core-supervisor.ts`）。额外两处按报告授权：
`fake-engine.ts` 的同一处登记（§3.1 明说「顺便检查」）与 `kernel.ts` 的私有
`withClockTimeout`（§3.3 的判据要假时钟推得动；行为与 foundation 的 `withTimeout` 相同）。

### 审查执行待决（R-05 新增）

| 编号 | 日期 | 问题 | 阻塞的步骤 | 状态 |
|---|---|---|---|---|
| Q35 | 2026-10-09 | R-05 §6 的两条手工验收未跑（需要安装包 + 真 omp）：① 依次打开 10 条历史对话并重复，Core 内存不再线性上涨；② 运行中退出应用，`core.log` 各阶段齐全且无 `core did not exit in time, killing` | 无（代码与单测已按报告落地） | 记录：等产品负责人真机复核 |

## R-04 Core 重启 / 页面重载后 UI 不重新同步：时间线冻结、运行态卡死、死 store 掩盖缺口（2026-10-09）

**来源**：产品负责人交办的缺陷报告 `R-04 Core 重启 页面重载后 UI 不重新同步：时间线冻结、运行态卡死、死 store 掩盖.md`
（外部输入，不入库）。按报告 §3 的设计执行，未改契约、未动 `PROTOCOL_VERSION`。

**根因四条**：迁移期新旧两套 UI 时间线副本并存（新 `TimelineReplica` 从未被生产路径打开，
恢复逻辑却挂在它上面）；适配层 `session-port` 把 epoch+seq 压成「只有 seq」，换代信息在端口层丢掉；
epoch 是进程内计数器，两个先后启动的 Core 都从 1 开始；运行态只由通知积分，没有快照兜底。

**改法**：

1. **删死代码**（§3.1）：删掉 `ui/stores/timelines.ts`、`timeline-replica.ts`（含 CV-11 测试）、
   `queue.ts`、`interactions.ts`；`ConversationStores` 去掉三个字段，`stores/index.ts` 与
   `ui/index.tsx` 的引用一并清掉；`ui/api.ts` 删掉随之没有调用方的 `unsubscribeTimeline` /
   `listInteractions`（契约方法保留，Core 侧仍实现）。恢复逻辑全部改挂在真正在用的
   `TranscriptStore` 上。
2. **Core：epoch 跨进程唯一**（§3.2）。`TimelineHub` 的起点从 `1` 改为随机
   `randomEpochBase()`（`1 + floor(random * 2^40)`），`TimelineHubDeps` 新增可注入的 `epochBase`；
   现有断言固定 epoch 的用例统一传 `epochBase: 1`，并新增 S1（两个 hub 的首个 epoch 不等）。
   契约里 epoch 仍是 `int().positive()`，无需提升版本。
3. **端口：换代发 reset、旧页带真实 seq**（§3.3）。`session-port.ts` 的 `epochs` 表换成
   `positions`（`agentId → {epoch, seq}`）：`timeline.ops` 发现 epoch 变化就交 `reset`
   （丢掉这一批不丢数据 —— 整读位置在这批之后），同代照常交增量；`timeline.reset` 把位置换到
   `{epoch, 0}`；整读写回快照的 epoch+seq；**旧页（`beforeTurn`）交回真实 seq**（原先误填 epoch，
   翻页后触发副本的游标倒走不变式，对话进 failed 横幅）。
4. **UI 内核：`onCoreLost`**（§3.4）。`packages/ui-kernel` 的 `lifecycle` 新增 `onCoreLost(fn)`，
   `kernel.ts` 在 `wasReady && !ready` 时**同步**逐个调用（try/catch + `logger.error`），
   与 `onCoreReady` 一样跳过 `failures` 里的功能。放在内核而不是 conversation 里自己订阅
   `CoreStatusToken`：terminal / automations / browser 将来也要同一个时机。
5. **turnStates：快照打底 + 版本**（§3.5）。新增 `mark()` / `hydrate(threads, mark)` / `resetAll()`：
   非响应式 `version` + `touched` 记账，通知到过（即使内容没变）的那条线程不被出发时的旧快照覆盖；
   `resetAll` 清表但**不归零版本**；不走 `onTurnState` 回调，崩溃因此不会弹「已完成」。
   `threads.refresh()` 出发前 `mark()`，落地后 `hydrate(List.state)`；`stores/index.ts` 先建
   turnStates 再建 threads。
6. **TranscriptStore：陈旧标记与 resync**（§3.6）。新增 `#stale`、`markAllStale()`（只标记、不发请求）、
   `resyncVisible()`（只重读有监听者的对话，交回线程号给调用方刷控件表）、`#resync()`（清副本重读 +
   读一次队列）、`#isMounted()`（按 `#listeners` 的通道键判归属）；`open()` 开头先消化陈旧标记，
   `forget()` / `dispose()` 清理标记。`TranscriptReplica` 未改（它已有 resync）。
7. **装配**（§3.7）。`onCoreLost`：`turnStates.resetAll()` + `transcripts.markAllStale()`（全同步）；
   `onCoreReady`：逐步各自兜底 —— `threads.refresh`（每次都做）→ `posture.load` / 草稿读盘
   （**只有第一次**，否则重启会把输入框里尚未落盘的字用盘上旧版本盖回去）→ `resyncVisible()` 并刷
   对应控件表；任一步抛错只 warn，不再截断后续步骤。删除 `timelines.resubscribeAll()` 与基于空
   副本表的循环、`onTimelineReset` 订阅、`queue.changed` → `stores.queue` 的订阅、`interactions.*`
   → `stores.interactions` 的订阅（保留 `needs-confirm` 系统通知）。

**测试**（报告 §5 的 S1–S12）：

- `core/__tests__/timeline-channel.test.ts`：S1（20 次新建 hub，首个 epoch 两两不等）。
- `ui/stores/__tests__/session-port.test.ts`：S2（epoch 变化交 reset 而非 ops）、S2b（同代不误伤）、
  S2c（reset 后同代增量正常）、S3（旧页 seq 是真实水位 40 而不是 epoch）。
- `ui/transcript/__tests__/transcript-store.test.ts`：S4（reset 后同号 seq=1 的 ops 被应用，状态变 running）、
  S5（`markAllStale → resyncVisible` 只重读有订阅者的那条；另一条等 `open`）、S6（`forget` 后不抛错）。
- `ui/stores/__tests__/turn-states.test.ts`：S7（通知比快照新）、S7b/S7c（mark 之前可覆盖 / 内容不变不换引用）、
  S8（`resetAll` 后计数为零）、S8b（版本不归零）。
- `ui/__tests__/threads-store.test.ts`：S9（`refresh` 后 running 被认出来）、S9b（往返期间的通知不被旧快照盖回）、
  失败时不打底。
- `packages/ui-kernel/src/__tests__/kernel.test.tsx`：S10（ready → restarting → ready 时 lost 恰一次且早于下一次
  ready；starting → ready 不触发）、S11（一个功能的 lost 抛错不影响其它功能，错误进 logger）。
- `apps/desktop/src/renderer/__tests__/core-recovery.test.tsx`：S12（第一次 ready 读一次
  `conversation.drafts` / `conversation.permissionPosture`；重启后的 ready 不再读，`threads.list` 每次 ready 都发）。

**验收**：`bun run check` 全绿（1582 pass / 0 fail，202 文件 / 5173 断言；较 R-05 的 1569 多 13 条，
含新增装配级用例文件 `core-recovery.test.tsx`）。

**本轮偏差**：无契约形状变化、未动 `PROTOCOL_VERSION` 与协议快照。§3.4 里「`restarting` 一定早于新进程启动」
这一前提没有在本仓文档里单独成文（`CoreSupervisor` 的实现保证「先广播状态、再拉起子进程」），
`onCoreLost` 的同步语义依赖它；若将来看护人改成并行启动，需要重新核对这一条。

**未能核实、记入待决**：报告 §6 的四条手工验收需要安装包 + 真 omp（结束 `poietica-core.exe` 后
侧栏无残留运行态、当前对话自动重读一次且无 failed 横幅、续聊正常流式、切到旧对话时重读一次；
F5 重载后运行中对话仍显示运行中且关窗确认；重启后输入框内容不被回滚）。

### 审查执行待决（R-04 新增）

| 编号 | 日期 | 问题 | 阻塞的步骤 | 状态 |
|---|---|---|---|---|
| Q36 | 2026-10-09 | R-04 §6 的四条手工验收未跑（需要安装包 + 真 omp）：① Core 崩溃重启后时间线自动重读、运行态无残留；② F5 重载后运行中标记与关窗确认；③ 重启后输入框内容不回滚；④ 切到旧对话时才重读 | 无（代码与单测已按报告落地） | 记录：等产品负责人真机复核 |

## R-06 定时任务：提交未送达时运行永不结束，任务从此不再被调度（2026-10-09）

**来源**：产品负责人交办的缺陷报告 `R-06 定时任务：提交未送达时运行永不结束，任务从此不再被调度`
（外部输入，不入库）。严格按报告 §3 的设计执行，**无契约变更、未动 `PROTOCOL_VERSION`**。

**根因**：运行记录的结束只绑定在「一轮结束」（`turnSettled`）这一个事件上。而「Core 即时回显」之后
提交有了独立生命周期（pending → started / queued / failed），`failed` 这个结局**不经过任何一轮**，
Core 内部又没有把这个结局广播给别的模块 —— 于是 `Runner.start` 的 `await conversation.submit` 成功
返回、`outcome: 'running'` 被 publish，然后永远等不到 `onTurnSettled`。轮询还把 idle 也映射成 running，
反而一直替它「确认」；调度器见 `runner.isRunning` 为真就跳过，直到重启才由 `repairOnStartup → failOpenRuns`
解开。用户删掉那条自动化线程时，运行记录同样永远 open。

**改法**：

1. **conversation 侧广播两个结局**（§3.2）。`core-api/index.ts` 新增 `SubmissionFailed`（threadId /
   clientTurnId / deliverAs / error）与 `ThreadRemoved`（threadId）两条 `defineCoreEvent`。
   `submission-service.ts` 的 deps 加 `emitFailed`，并把**所有**「变为 failed」的路径收敛到一个私有
   `markFailed(row, error)`（写库、推 UI、发事件三件事只此一处）：`fail()`、`settleUnstarted()`、
   `cancelUnhanded()` 全部改走它；`recoverOnStart()` 的 `failPending` 已经改过库，只补发事件
   （那段发生在 conversation 的 setup 里，automations 的订阅还没建立 —— 它自己的 `repairOnStartup`
   会把全部 open run 收成 failed，两处各管各的那一半，正好接得上，无需调整模块顺序）。
   `rg "status: 'failed'" submission-service.ts` 改完后只剩 `markFailed` 里那一处。
2. **删除也进事件**：`threadRemoved` 挂在既有的 `onThreadRemoved` 统一遗忘钩子里发（与 RPC 通知同源），
   没有再开第二个发出点。
3. **runner 按 threadId 收口**（§3.3）。新增 `onSubmissionFailed` / `onThreadRemoved` 两个入口：
   前者只认 `deliverAs === 'turn'`（用户在运行中插的话失败不该让这次运行失败），复用现成的 `fail()`
   （含 `setIssue`）；后者**不**走 `fail()`，就地写 `cancelled` + 「运行所在的对话已被删除」——
   对话被删不是任务出问题，不该在任务卡片上挂 issue。`watchAwaiting` 的映射删掉「idle → running」
   这一档（idle 不是「运行中」的证据，轮询只搬 running ↔ awaiting）。
4. **`start()` 不覆盖结局**：`await conversation.submit` 之后不再直接 `publish(run)`，而是重读库 ——
   交接失败的**事件可能早于 submit 的 await 返回**，直接 publish 会把刚收好的 failed 覆盖回 running。
   只有还开着的运行才接着 `publish` + `watchAwaiting`。
5. **装配**（§3.4）：automations 的 setup 里与 `turnSettled` 并列订阅这两条事件。

**反向验证**（守则 10：先写一个在旧代码上失败的测试）：新用例在 HEAD 的 runner 上
A1/A3/A4/A5 全红（A5 连方法都不存在；A4 正是 idle→running 那一条，实测 `Expected "awaiting",
Received "running"`），A6 红（运行记录停在 `running`，恢复后第二次手动运行被判 `already_running`）；
conversation 侧五条新用例在旧代码上全红（事件不存在）。恢复实现后全绿。

**测试**：

- `features/automations/src/core/__tests__/runner.test.ts`（新建）：A1（提交未送达 → failed、isRunning
  变假、下一次能起来）、A2（失败事件早于 submit 返回：结局不被覆盖回 running）、A3（followUp 失败被忽略）、
  A4（idle 不把 awaiting 改回 running，也不白推一次 runUpdated）、A5（删对话 → cancelled 且不挂 issue）。
- `features/automations/src/core/__tests__/module.test.ts`：A6（fake engine 的 `openSession` 抛错 → 运行
  落成 failed；恢复后下一次手动运行不抛 `already_running`）。测试缝是替换 `FakeEngine.openSession`
  与新增的 `stalledTurnEngine()`（收下提交但不产 turn.upsert，用来落到 `settleUnstarted` 那一档）。
- `features/conversation/src/core/__tests__/conversation-core.test.ts`：A7 四条（冷打开失败 /
  `settleUnstarted` / `cancelUnhanded` / `recoverOnStart` 各恰好发一次、字段正确，recoverOnStart
  那条同时断言库与 `submissions.changed` 都对得上）、A8（删线程：RPC 通知与 Core 事件各一次）。

**验收**：`bun run check` 全绿（1593 pass / 0 fail，203 文件 / 5213 断言；较 R-04 的 1582 多 11 条）。

**本轮偏差**：无契约形状变化、未动 `PROTOCOL_VERSION` 与协议快照。文件清单与报告 §1 一致；
额外一处是 `runner.test.ts` 的 `build()` 里加了个 `stalledTurnEngine()` 测试缝（报告 §5 的 A6 要求
「openSession 抛错」的那一档之外，A7 的 settleUnstarted 需要「收下但不产 op」的桩，报告未点名测试缝，
按 R-03/R-05 的先例记在这里）。

**未能核实、记入待决**：报告 §6 的手工验收需要安装包 + 真 omp（建一个每分钟运行的任务、删掉所用
模型的服务商凭据或把工作区目录改名、等一次运行 → 列表里显示失败与原因；恢复凭据后下一分钟正常再跑）。

### 审查执行待决（R-06 新增）

| 编号 | 日期 | 问题 | 阻塞的步骤 | 状态 |
|---|---|---|---|---|
| Q37 | 2026-10-09 | R-06 §6 的手工验收未跑（需要安装包 + 真 omp）：① 每分钟任务在「冷打开失败 / 服务商凭据被删」时那次运行显示失败与原因；② 恢复后下一分钟任务正常再跑 | 无（代码与单测已按报告落地） | 记录：等产品负责人真机复核 |

## R-07 附件引用登记的三个缺口：草稿过夜即失效、未送达的提交不受保护、分支不继承引用（2026-10-09）

**来源**：产品负责人交办的缺陷报告 `R-07 附件引用登记的三个缺口：草稿过夜即失效、未送达的提交不受保护、分支不继承引用.md`
（外部输入，不入库）。契约形状有变化：新增 `attachments.setOwnerRefs`，
`PROTOCOL_VERSION` 8 → 9，已重跑 `bun run protocol:snapshot`（快照只多这一个方法，参数 `ownerKey` 正则
`^ui:[a-z0-9.:-]+$`、`attachmentIds` 上限 10 000，结果 `{ missing: string[] }`）。

**根因**：引用登记只在「附件真的被交给模型」那一刻做（`submission-service.deliver` 里唯一的 `retain`），
而「谁还需要这个附件」的真实集合更大 —— 草稿（UI 持有，随 `conversation.drafts` 落盘）、
已接受但未送达 / 交接失败的提交（Core 库里，`retry` 会再用）、继承了历史的**分支**。
回收（sweep，24 小时宽限）不认这三类，于是「明天发不出去的草稿」「隔天重试永远 `attachments.not_found`」
「删了原对话后分支里的文件不见了」。

**改法**：

1. **谁持有谁登记**（§3.3）。`submission-service.submit()` 把 `retain` 挪到 `repo.insert(row)` 之后、
   **同一同步段内**（写库与登记之间不会被 sweep 插进来）；`deliver()` 里的那一句删除（`resolve` 保留）。
   `thread-service.fork` 在 `repo.insert(next)` 之后 `copyOwner(源线程, 分支)`。
2. **attachments 侧新增两件能力**（§3.2）。仓储 `replaceOwner(ownerKey, itemIds, at)`（事务内先删后插，
   先查存在性再插 —— 外键开着，缺的 id 收集成 `missing` 交回调用方）与 `copyOwner(from, to, at)`
   （`INSERT OR IGNORE ... SELECT`）。服务 / `core-api` / 契约 / handler 一路透出，
   `attachments.setOwnerRefs` 只认 `ui:` 前缀的 ownerKey（UI 不得误释放 Core 的引用）。
3. **草稿由 UI 整体替换**（§3.1 的幂等原则）：丢一次、重发一次都不漂移；逐个 retain/release 在离线、
   重启、丢包下都会漂移。

**本轮偏差（重要，与报告 §3.4 原文不一致，已与产品负责人确认）**：草稿引用的同步**放在 attachments 的 UI**，
不是 conversation 的 UI。原因：报告原文让 conversation 的 UI `dependsOn: ['attachments']`，
而 attachments 的 UI 本来就 `dependsOn: ['conversation', 'platform']`（附件入库口要往输入框树里注入
`composerProviders`）—— 两边一合就是环，`sortModules` 会在内核 `start()` 时抛
`kernel.module_graph_invalid`。定稿（方案 1）：

- conversation 的 `ui-api` 只多交一份只读视图 `ConversationUi.draftAttachments`：
  `ids()`（未恢复读盘时**返回 null**）、`subscribe()`（集合真的变了才回调，打字不触发）、
  `drop(ids)`（跨所有草稿移除，返回实际移除条数）。conversation 因此**不认识** attachments，
  也不调 `attachmentsContract`；未新增回调注册这类协作方式。
- attachments 的 UI 持有同步逻辑（`ui/draft-refs.ts`）：读 `draftAttachments.ids()` → 调自己的
  `attachments.setOwnerRefs`，整体替换、按集合键去重、500ms 去抖、**请求串行**
  （整体替换是后写覆盖，交错会互相盖掉）、集合没变不重发、Core 每次 `onCoreReady` 无条件重发一次。
  返回的 `missing` 经 `drop()` 清掉草稿里的失效附件，并按实际移除条数弹一条
  `ToastsToken` 的 warning：「有 N 个草稿附件已失效，已从草稿中移除」。
- 契约上限由报告 §3.2 的 `.max(500)` 放宽到 `.max(10_000)`：整体替换被拒或截断等于把超出的部分
  全部释放，宁可放宽。

**`ids()` 返回 null 是本条的关键**：attachments 的 `onCoreReady` 可能先于草稿从盘上恢复。
conversation 的草稿读盘因此把「读失败」与「盘上没有值」分开（读失败只 warn、保持未恢复，
下一次 ready 再读；恢复成功才 `markRestored()` 并通知一次）。此前 `.catch(() => null)` 把两者混在一起。
同理，`onCoreReady` 的存在使草稿读盘不是「只在首次 ready」——未恢复时每次 ready 都重试（R-04 §1.5
的「hydrate 只做一次」约束仍然成立：恢复完成后不再重读）。

**反向验证**（守则 10：先写一个在旧代码上失败的测试）：T6 / T7 在临时还原两处修复的旧行为下全红，
报 `attachments.not_found`；恢复实现后 9 pass / 0 fail。D2（打字不通知）第一版实现是红的
（`lastKey` 初始为 null，第一下打字就被当成「集合变了」），已修。

**测试**：

- `features/attachments/src/core/__tests__/service.test.ts`：T1（`replaceOwner` 只留点名的，其余 25 小时后
  被回收）、T2（换成空集合 → 可回收）、T3（不存在的 id 不抛错、报 `missing`、存在的照常登记）、
  T4（`copyOwner` 后释放源 owner，文件仍被保住）。
- `features/attachments/src/core/__tests__/module.test.ts`（新建）：T5（`ownerKey: 'conversation:thread:x'`
  → `kernel.invalid_params`；`ui:` 前缀正常往返并返回 `{ missing: ['ghost'] }`）。
- `features/conversation/src/core/__tests__/module.test.ts`：T6（带附件提交、`engine.openSession` 抛错 →
  落 failed → 推时钟触发 attachments 模块的真 sweep（canary 消失为证）→ 恢复引擎 → `submissions.retry`
  后提交不再是 failed）、T7（带附件跑完 → fork → 删原线程 → 真 sweep 后附件仍在）。
- `features/conversation/src/ui/stores/__tests__/draft-pin.test.ts`（新建）：D1（恢复前 `ids()` 为 null；
  恢复后跨草稿去重升序）、D2（打字不通知；增删附件各通知一次；恢复完成通知一次）、
  D3（hydrate 之后 `markRestored`，`ids()` 是恢复进来的那一份）、D4（`drop` 从所有草稿移除并返回条数；
  没有命中时不换引用）。
- `features/conversation/src/ui/stores/__tests__/composer.test.ts`：T8（`dropAttachments` 跨草稿移除，
  正文与其它附件不动）。
- `features/attachments/src/ui/__tests__/draft-refs.test.ts`（新建）：U1（`ids()` 为 null 时不发请求）、
  U2（去抖后只发一次、参数是排好序的 id）、U3（集合不变不重发；`onCoreReady` 后不变也重发）、
  U4（返回 `missing` 时调 `drop` 并提示实际移除条数）、U5（失败记 warn、下一次变化重发）、
  U6（连续两次变化：请求串行、按顺序到达、`maxInFlight === 1`）。
  另加 U6b（守则 8.1：视图读草稿自己抛错也只记 warn、链子上不留未处理的 rejection ——
  `schedule()` 是用 `void flush()` 起那一段的，所以整段都在 `try` 里）。
- `apps/desktop/src/renderer/__tests__/r07-draft-refs-assembly.test.tsx`（新建）：U7（conversation 与
  attachments 两个 UI 功能一起装载不抛 `kernel.module_graph_invalid`，两边 setup 都成功）。
  这条在**故意恢复成环**（给 conversation 的 `dependsOn` 加 `'attachments'`）时实测变红。

**验收**：`bun run check` 全绿（1614 pass / 0 fail，207 文件 / 5269 断言；较 R-06 的 1593 多 21 条）。

**未能核实、记入待决**：报告 §6 的两条手工验收需要安装包 + 真 sweep（贴一张图不发送、过一夜 /
临时推 `created_at` 之后图仍在且能发送；fork 一条带文件附件的对话、删原对话、强制 sweep 后
在分支里让 agent 读那个文件）。

### 审查执行待决（R-07 新增）

| 编号 | 日期 | 问题 | 阻塞的步骤 | 状态 |
|---|---|---|---|---|
| Q38 | 2026-10-09 | R-07 §6 的两条手工验收未跑（需要安装包 + 真 sweep）：① 输入框贴一张图不发送，等一次 sweep 后图仍在、能发送；② fork 带文件附件的对话、删原对话、强制 sweep 后分支里 agent 仍能读到该文件 | 无（代码与单测已按报告落地） | 记录：等产品负责人真机复核 |

## R-08 细枝末节问题汇总（2026-10-10）

**来源**：产品负责人交办的审查报告 `R-08 细枝末节问题汇总 a31adb51cf8a43bf8c207e2344a3a6f0.md`
（外部输入，不入库）。十六条彼此独立的小问题，逐条一个小提交；其中改变契约形状的条目
各自提升一次 `PROTOCOL_VERSION` 并重跑 `bun run protocol:snapshot`。

### 审查执行待决（R-08 新增）

| 编号 | 日期 | 问题 | 阻塞的步骤 | 状态 |
|---|---|---|---|---|
| Q39 | 2026-10-10 | R-08-6：只是想「看一眼」历史对话也要冷启动完整 AgentSession —— `threads.open` 预热、`timeline.subscribe` / `controls.get` 都 acquire 会话（拉起工具与 MCP 连接），既慢又占内存，还会把真正在用的空闲会话挤出 `MAX_IDLE_SESSIONS` | 无（R-08-6 本身就是待决项，报告明确要求先登记、不自行决定）。可选的采纳路径：引擎端口加只读的 `sessionFiles.readPage(file, agentId, beforeTurnId)`，会话不在池子里时 `timeline.subscribe` 走它，第一次发送 / 改控件才 acquire；若采纳需重新审视 R-03「先 acquire 再 position」的前提（只读路径不产生 reset，反而更简单） | 记录：等产品负责人 / 主开发裁决 |
