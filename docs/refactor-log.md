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

**验收**：`bun run  all` 全绿（1548 pass / 0 fail，201 文件 / 5057 断言）。报告 §5 的四条 grep 全过：
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

**验收**：`bun run  all` 全绿（1558 pass / 0 fail，201 文件 / 5105 断言）。

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

**验收**：`bun run  all` 全绿（1569 pass / 0 fail，201 文件 / 5143 断言；较 R-03 的 1558
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

**验收**：`bun run  all` 全绿（1582 pass / 0 fail，202 文件 / 5173 断言；较 R-05 的 1569 多 13 条，
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

**验收**：`bun run  all` 全绿（1593 pass / 0 fail，203 文件 / 5213 断言；较 R-04 的 1582 多 11 条）。

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

**验收**：`bun run  all` 全绿（1614 pass / 0 fail，207 文件 / 5269 断言；较 R-06 的 1593 多 21 条）。

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

### 逐条进度

#### R-08-1 图片在提交时被同步读两次（2026-10-10）

**根因**：`OmpSession.submit` 先 `readFileSync` 读一遍把图 base64 塞进 `attachment.upsert`，
随后 `preparePrompt` 又读一遍交给 omp prompt。20 MB 的图在 Core 主线程上同步读两次，
多图时把整条事件循环压住（别的对话的流式输出一起卡）。

**改法**：Q28「图片只走内联」的裁决不变，只改读法。`prompt.ts` 新增 `loadImages()` /
`LoadedImage`（`readFile` + `statSync` 限 20 MB，可注入读盘与 stat 供测试计数），
`runTurn` 里只调用一次，得到的同一批像素既画时间线那一帧又交给 omp prompt；
`session.ts` 删掉 `readImageDataUrls`，attachmentId 只签一次；adapter 接线 `loadImages`
与 `promptWithImages`。

**测试**：`packages/engine-omp/src/__tests__/queue.test.ts` 加计数假读盘的用例（每张图恰好
读一次）；`controls.test.ts` 的既有用例随签名调整。

**验收**：`rg readFileSync packages/engine-omp/src/session.ts` 零命中；`bun run  all` 全绿。

#### R-08-2 每条 `turn.upsert` 都查一次 SQLite（2026-10-10）

**根因**：`EventRouter.attributeClientTurn` → `submissions.clientTurnIdOf` → `repo.findByTurnId`。
流式期间 `turn.upsert` 很频繁，每次一次同步查询。

**改法**：`SubmissionService` 内维护 `Map<threadId, Map<turnId, clientTurnId>>`；`markTurn`
写入（覆盖之前缓存的 null）；`clientTurnIdOf` 先查缓存，未命中再查库并把结果（含 null）
写回；`forget` 随线程删除清掉整格。

**测试**：`features/conversation/src/core/__tests__/submission-service.test.ts`：同一 turn
连续 100 次 upsert，`findByTurnId` 调用 ≤ 1 次；null 缓存被 `markTurn` 覆盖；`forget` 后
缓存不再命中。

#### R-08-3 交互代理在 `toUpstream` 抛错时会悬挂（2026-10-10）

**根因**：`InteractionBroker.settle` 里 `resolve(toUpstream(answer))` 一抛，异常冲向
`answer()` 的调用方，而工具那边 await 的 Promise 永不兑现 —— 这次工具调用卡死，
卡片却已经从待答表里出去了。

**改法**：`try { resolve(toUpstream ? toUpstream(answer) : answer) } catch (e) { reject(e) }`。

**测试**：`packages/engine-omp/src/__tests__/interactions.test.ts` 加用例：`toUpstream` 对
dismiss 抛错 → `cancelAll()` 后 ask 的 Promise 以该错误 reject（旧代码上该用例超时）。

#### R-08-4 `Emitter` 监听者异常只有 `console.error`，没有上下文（2026-10-10）

**根因**：`Emitter.fire` → `lastResort` 只写一行裸文本，Host 收进 `core.log` 后看不出是
哪个线程、哪种事件。

**改法**：`Emitter` 新增可选 `EmitterOptions.onListenerError`，缺省仍走 `lastResort`；
`OmpSession` 与 `InteractionBroker` 接线成 `logger.error('listener threw', { error, stack })`。
异常依旧不向 `fire` 的调用方重抛（与 R-02 的事件泵记 warn 同一风格）。

**测试**：`packages/foundation/src/__tests__/emitter.test.ts`：监听者抛错时
`onListenerError` 被调用、其它监听者仍被调用、`fire` 本身不抛。

#### R-08-5 Core 崩溃时排队的话被静默丢弃（2026-10-10）

**根因**：omp 的插话 / 排队队列住进程内存里，Core 一崩就没了；对应提交行停在 `queued`，
而 UI 只画 `deliverAs === 'turn'` 且 `status !== 'queued'` 的行 —— 用户完全不知道自己
排的话没了。

**改法**：

1. `submissions-repository` 的 `failPending` 扩成 `failUndelivered`（`status IN ('pending','queued')`）；
   `deleteStaleTerminal` 只清 `started`。`recoverOnStart` 走新方法，两条路都落
   `failed(core_restarted)` 并补发 `submissionFailed`（automations 对非 turn 忽略）。
2. `deliver()` 的 `deliveredAs` 改由**这一刻的会话状态**决定：会话空闲时 retry 一条
   failed 的 followUp / steer 自然按新一轮交出去（记 `queued` 等于把已经开跑的真实轮
   标成还在排队）。
3. UI：`withSubmissionRows` 让 failed 的 steer / followUp 也进时间线并标 `undelivered`，
   气泡画虚线框；失败横幅与「取回文字」的正文改从 `readFailedSubmissionText`（最后一条
   failed 提交行）取，本机乐观记录优先。

**测试**：`submission-service.test.ts` 加 4 条（recoverOnStart 收 queued、空闲 retry → turn
且留 pending、忙时 retry followUp → queued、忙时 steer → queued）；
`transcript-store.test.ts` 加 4 条（failed 的 followUp / steer 画气泡、queued / pending
不画、正常 turn 不带标记、失败正文只认最后一条）。

#### R-08-7 `ConversationCore` 是约 40 个纯转发方法的门面（2026-10-10）

**根因**：每加一个能力都要在门面上再写一遍转发；R-01 / R-03 / R-06 都给它添过方法。
报告要求**在 R-01、R-03、R-06 全部合入之后再做** —— 三者都已合入，本项因此可做。

**改法**：`threads` / `turns` / `submissions` 改成 `readonly` 属性（构造期就装好的实例），
`handlers.ts` 与 `conversation-service.ts` 直接调它们，门面上只剩真正跨服务的编排
（`dispose`、线程删除的遗忘钩子仍在构造器里接）与两个测试观察口（`onEvent`、
`hasThreadState`）。跨服务的惰性闭包一条都没动 —— 它们本来就只认实例字段。

**偏差**：报告写的是「只读属性公开」，实际保留的三个方法里 `onEvent` / `hasThreadState`
是单测用的观察口（报告 §5C 没点名）。删掉它们要改写 `conversation-core.test.ts` 里
喂事件的那几条用例，属于任务点名的范围之外，故保留。

**测试**：`conversation-core.test.ts` 加两条：三份服务取到的是同一批实例（`threads`
认得出 `turns` 开出来的会话、`submissions` 读得出同一次提交）；门面原型上的方法名
**恰好**是 `dispose` / `hasThreadState` / `onEvent`（再往门面上加纯转发就会红）。

#### R-08-8 数据库来自更新版本时要等约 15 秒重启才报错，且报成 `crash_loop`（2026-10-10）

**根因**：`runMigrations` 抛 `MigrationError` → `apps/core/src/main.ts` 一律退出码 1 →
`core-supervisor` 当崩溃退避重启五轮。降级安装是确定性失败，重试没有意义，
界面最后只说「Agent 引擎反复崩溃」。

**改法**：

1. `storage-sqlite` 把「数据库版本高于程序已知迁移」单独抛 `DataTooNewError`
   （`MigrationError` 的子类），其余迁移错误仍是 `MigrationError`。
2. `CORE_EXIT_CODES` 加 `dataTooNew: 4`、`startFailed: 5`；`core-kernel` 新增
   `coreStartFailureExitCode(error)` 做分类（`DataTooNewError` → 4；迁移错误 /
   `kernel.module_graph_invalid` / `kernel.unhandled_method` / `kernel.contract_invalid`
   / `kernel.table_access_denied` → 5；其余 → 1 继续按崩溃重试）。
   `apps/core/src/main.ts` 的 serve catch 用它选退出码。
3. `CoreFailureReason` 与 `CORE_FAILURE_REASONS` 加 `'data_too_new' | 'start_failed'`；
   `onExit` 见到 4 / 5 直接 `fail()`，不再排重启。UI 的 `CoreStatus.reason` 联合类型与
   `FAILURE_TEXT` 同步（「数据来自更新的 Poietica，请安装新版本」/「Agent 引擎启动失败，请查看日志」）。

**契约变更**：`core.status` / `core.getStatus` 的 `reason` 枚举加两个值，
`PROTOCOL_VERSION` 9 → 10，已重跑 `bun run protocol:snapshot`（快照只有这两处枚举变长）。

**测试**：`core-supervisor.test.ts` 加两条：退出码 4 → 立刻 failed/data_too_new、推进
60 秒也只 spawn 过一次；退出码 5 → failed/start_failed 同理。
`core-kernel/src/__tests__/start-failure.test.ts`（新建）钉住退出码分类；
`runtime-layout` 的 `CORE_EXIT_CODES` 期望值同步；`core-failure-notice.test.ts` 覆盖
八个 reason 的文案与全表。

#### R-08-9 UI 内核串行执行所有功能的 `onCoreReady`（2026-10-10）

**根因**：`runCoreReady` 逐个 `await`，一个功能的慢请求（如 conversation 的 `threads.refresh`）
把后面所有功能的首屏数据都压住；功能之间并没有顺序依赖（依赖顺序只在 setup 阶段有意义）。

**改法**：按 `featureId` 把钩子分组 —— 组内仍按注册顺序串行（功能内部的前后关系只有它自己
知道），组间 `Promise.all` 并行。错误处理不变：每个钩子仍各自 catch、记 error、弹一条 toast，
一个功能失败不影响其它功能。

**测试**：`packages/ui-kernel/src/__tests__/kernel.test.tsx` 加 R-08-9 用例：alpha 的第一个钩子
挂在门上，beta 已经跑完（并行）；放行后 alpha 的第二个钩子在第一個之后才跑（同功能内串行）。
旧实现下第一条断言就是红的（beta 还没起步）。

#### R-08-10 `coreCaller.call` 在调用方的 signal 上挂监听不摘（2026-10-10）

**根因**：`opts.signal.addEventListener('abort', …)` 从不 `removeEventListener`。调用方若用
一个长寿 signal（模块生命周期的 AbortController）反复调用，监听器与闭包（含每次的 `ac`）
单调累积。

**改法**：监听器存成变量，`finally` 里 `removeEventListener`；`opts.signal` 已 aborted 时
不挂监听、直接 `ac.abort()`，让 forward 侧按取消处理（超时判定仍只认自己的 timer，
调用方主动取消不会被误报成 `kernel.timeout`）。

**测试**：`rpc-hub.test.ts` 加两条：包装过的 signal 连续调用 100 次，add/remove 净增 0；
已 aborted 的 signal 发起调用 → `kernel.cancelled`。

#### R-08-11 退出顺序：Host 模块先关，Core 后停（2026-10-10）

**根因**：`quit.ts` 里 Host 的 `onShutdown`（终端 `disposeAll`、浏览器、偏好 flush）先跑，
`supervisor.stop()` 最后。Core 关停期间（会话中止、工具收尾）仍可能调用 owner='host' 的
方法，那时对应服务已经释放，只剩一串噪音错误。

**改法**：顺序改为「先 `supervisor.stop()`，再 Host 钩子（倒序），再 disposables（倒序），
最后销毁窗口」。反方向的顾虑不存在：Host 钩子（terminal、browser、preferences、platform）
全是本地动作，没有一样需要 Core 活着。

**测试**：新建 `packages/host-kernel/src/__tests__/quit.test.ts` 断言完整调用顺序
（`supervisor.stop → hook:browser → hook:terminal → dispose:second → dispose:first →
windows.destroyAll → exit`）。旧顺序下第一个断言即失败（实测 2 条全红）。
另加一条：`quit` 只跑一次；钩子抛错只记 warn，不拦住后面的清理。

**注意**：`quit.ts` 顶层 import electron，测试用 `mock.module('electron', …)` 注册后才动态
import —— 静态 import 会在 mock 之前求值而直接抛错。

#### R-08-12 Windows 上原子写的 rename 会被杀软 / 索引器偶发拒绝（2026-10-10）

**根因**：`writeFileAtomic` 写临时文件后直接 `rename`。目标文件被 Defender 的实时扫描或
Windows Search 索引器短暂打开时，NTFS 的改名抛 `EPERM` / `EACCES` / `EBUSY`，这次写入
直接失败（`JsonDocument` 只记一条 error），偏好 / 草稿 / 窗口状态就悄悄丢了。

**改法**：抽出 `renameWithRetry(renameFile, from, to)`：对这三个错误码退避重试
（10→20→40…，总等待封顶 2 秒），仍然失败才抛最后一个错误；其它错误码立刻抛，不白等。
`writeFileAtomic` 通过新的可选注入点 `{ rename, sleep }` 调它，失败时照旧删临时文件。

**测试**：`packages/fs-kit/src/__tests__/atomic.test.ts` 加 4 条：前两次 EPERM 第三次成功；
EACCES / EBUSY 同样重试、`ENOENT` 立刻抛出；一直拒绝时封顶后抛最后一个错误；
`writeFileAtomic` 走重试路径且临时文件不残留。

#### R-08-13 附件回收与同内容导入的竞态（2026-10-10）

**根因**：`sweep` 先 `deleteFile(行)` 再 `await rm(文件)`；恰好在这个 await 之间导入同一内容，
`store` 看到 `existsSync(target)` 为真就走去重分支（重新插 file / item 行，不碰盘），
随后 sweep 的 `rm` 把文件删掉 —— item 指向不存在的文件，从此永远读不到。

**改法**：服务内加一把 promise 链互斥 `serial()`，`importPaths` / `importData` / `sweep`
全部排在同一条链上（导入是用户操作、sweep 每 6 小时一次，串行化没有体感成本）。
链子用 `.then(fn, fn)` 起步、失败用 `.catch(() => undefined)` 吞在自己那一格，
所以一步失败不会卡住后面排队的人。同时给 `sweep` 的删文件加了测试注入点
`removeFile`（默认仍是 `rm(file, { force: true })`）。

**测试**：`features/attachments/src/core/__tests__/service.test.ts` 加 R-08-13 用例：假 `rm`
用手动 resolve 的 Promise 把「表已删、文件还没删」这一刻钉住，此刻发起同内容导入 ——
导入在 sweep 结束前**不能完成**（旧实现里它几拍之内就走完并从 Promise 里出来），
放行后文件必须仍在且内容完整。把 `serial` 换成空壳重跑，该用例红（`importedEarly` 为真、
断言文件存在时已不存在）。

#### R-08-14 `update.download` 用了默认 30 秒超时（2026-10-10）

**根因**：下载安装包通常超过 30 秒。UI 请求超时并发 `$/cancelRequest`，而 Host 的处理函数
忽略取消、下载继续 —— 界面状态靠 `update.stateChanged` 仍然正确，但调用方拿到一个假的
超时拒绝，且 `update-banner.tsx` 用的是裸 `void api.download()`，于是那是一条未处理的
rejection（还有一条误导性的超时日志）。

**改法**：契约里 `update.download` 声明 `timeoutMs: 0`（结果由通知说话）、
`update.check` 声明 `timeoutMs: 60_000`（一次网络往返，30 秒偏紧）；横幅的下载动作改成
`.catch(logger.warn)`，组件多收一个 `logger`（`ctx.logger`）参数。

**契约变更**：`PROTOCOL_VERSION` 10 → 11，已重跑 `bun run protocol:snapshot`
（快照 diff 只有这两个方法的 `timeoutMs`）。

**测试**：`packages/protocol/src/__tests__/contract-05.test.ts` 的超时表加两行；
新建 `features/update/src/ui/__tests__/update-banner.test.tsx`：点「下载」会发起请求；
请求拒绝只留一条 warn（旧实现下这条用例因未处理的 rejection 直接红）。

#### R-08-15 终端重放与实时输出之间没有序号（2026-10-10）

**根因**：渲染进程重载时先订阅输出、再请求 replay，两段之间到达的输出既在 replay 里又在
通知里（或反过来漏掉），没有序号就分不清谁覆盖了谁 —— 反复 F5 会看见重复或缺行。
另外 `RingBuffer` 按 UTF-16 码元裁剪，可能从 ANSI 转义序列 / 宽字符中间切断，重放的第一行
是乱码。

**改法**：

1. 服务端每个终端维护累计输出长度 `offset`：`pty.onData` 只加不减（环缓冲裁掉也不回退），
   `createOutputBatcher` 的 `flush(data, offset)` 带上这一段的起点，`terminal.output`
   通知加 `offset`、`terminal.replay` 返回 `{ data, endOffset }`。
2. UI 侧按「已经写进画面的末尾位置」cursor 去重：`replaying` 期间到达的通知先进 `pending`；
   replay 回来后 `cursors.set(terminalId, replay.endOffset)` 再按序放行 —— 整段落在 cursor
   之前的丢掉，只有部分重叠的裁掉前缀，起点在 cursor 之后的照原样写。攒下的输出有 1 MB
   上限（超了丢最老的并记 warn），避免一个配不上会话的 terminalId 无限攒。
3. `RingBuffer` 的切点往后找到第一个 `\n` 再从它之后留（整块都没有换行时仍按码元切，
   否则重放会被清空）。
4. 标签在 `adopt` 之后立刻推上 store（不等 replay），replay 失败只记 warn 并把攒下的
   通知原样写下去；`restore()` 在 `list` / `replay` 两个 await 之后重新检查 `disposed`
   与「用户是否已经关掉了它」。

**契约变更**：`terminal.output` 加 `offset`、`terminal.replay` 的结果加 `endOffset`，
`PROTOCOL_VERSION` 11 → 12，已重跑 `bun run protocol:snapshot`（快照 diff 只有这两处形状）。

**测试**：host `terminal-service.test.ts` 加 3 条（合批段的 offset 是累计位置、`endOffset`
不随 256 KB 环裁剪回退、重放末尾与随后通知的起点对齐）；`output-batcher.test.ts` 加 2 条
（每段 flush 带自己的起点、起点不随定时器到期重置）；`ring-buffer.test.ts` 加 2 条
（跨块与单块都从行首切）；ui `terminal-store.test.ts` 加 7 条（重放覆盖的整段不写第二遍、
部分重叠只写尾巴、没覆盖的原样写、攒下的按到达顺序放行、replay 之后不再攒、replay 失败
不卡住、关闭时丢掉缓存）。把 `writeChunk` 的去重换成直接写，前两条即红（实测画面变成
`abcdefefgh`）。

#### R-08-16 已退出的终端一直留在表里（2026-10-10）

**根因**：shell 自己退出后条目保留（带整个重放缓存），直到 UI 显式 close。UI 崩溃或漏调
close 时这些条目只增不减。

**改法**：`Entry` 记 `exitedAt`（注入的 `Clock`，默认 `systemClock`），`open` 开头顺手
`sweepExited()` 掉「退出超过 10 分钟且未被 close」的条目（不加定时器）。清理只放弃条目与
它的重放缓存，不再补杀进程（已经退出的 PTY 没有可杀的树）。

**测试**：`terminal-service.test.ts` 加 3 条：退出 10 分钟零 1 毫秒后下一次 open 把它清掉
（`list` 里没有、`replay` 报 `terminal.not_found`）、退出不到 10 分钟与还在跑的都不动、
清理不触发 `killTree`。

### 审查执行待决（R-08 新增）

| 编号 | 日期 | 问题 | 阻塞的步骤 | 状态 |
|---|---|---|---|---|
| Q39 | 2026-10-10 | R-08-6：只是想「看一眼」历史对话也要冷启动完整 AgentSession —— `threads.open` 预热、`timeline.subscribe` / `controls.get` 都 acquire 会话（拉起工具与 MCP 连接），既慢又占内存，还会把真正在用的空闲会话挤出 `MAX_IDLE_SESSIONS` | 无（R-08-6 本身就是待决项，报告明确要求先登记、不自行决定）。可选的采纳路径：引擎端口加只读的 `sessionFiles.readPage(file, agentId, beforeTurnId)`，会话不在池子里时 `timeline.subscribe` 走它，第一次发送 / 改控件才 acquire；若采纳需重新审视 R-03「先 acquire 再 position」的前提（只读路径不产生 reset，反而更简单） | 记录：等产品负责人 / 主开发裁决 |

#### R-08 收尾：未能核实的两条手工验收（2026-10-10）

16 条里 15 条已落地（R-08-6 按报告要求只登记待决），每条一个提交。协议快照随
R-08-8（9 → 10）、R-08-14（10 → 11）、R-08-15（11 → 12）各提升一次。
`bun run  all` 全绿（1668 pass / 0 fail，211 文件 / 5585 断言）。

两条验收需要**打包应用 + 真机**，与 R-03 §5 / R-05 §6 / R-06 §6 同例，代码侧已由单测覆盖：

| 条目 | 手工验收 | 阻塞 |
|---|---|---|
| R-08-15 | 终端里跑 `ping -t 127.0.0.1`，反复 F5，输出不重复、不缺行（单测已钉住 offset 去重的四条路径） | 安装包 + 真 PTY |
| R-08-16 | 退出终端后放 10 分钟，再开新终端 → `terminal.list` 里不再有它 | 安装包（要跨越 10 分钟的真实时间） |

另：R-08-1 的 `rg readFileSync packages/engine-omp/src/session.ts`、R-08-14 的
「快照 diff 只有 timeoutMs」两条已随各自提交核过；R-08-2 的「100 次 upsert 只查一次库」
由 `submission-service` 的查询计数用例钉住。

## R-09 omp 提示按级别上屏：info 不再画成报错（2026-10-10）

**来源**：产品负责人交办的审查报告 `R-09 …`（外部输入，不入库；对应问题 3「每开一段新对话都会冒出
一条假报错」）。**不改契约**：`NoticeFrame` 本来就带 `level` / `source`，未提升 `PROTOCOL_VERSION`，
协议快照不应变化。

**根因**（链路已在 omp 18.5.0 源码里核实）：

1. **缺陷 A（engine-omp）**：`dispatchOmpEvent` 不看级别，把 omp 给 TUI 状态栏的带外提示
   （`xd://` 挂载 / 卸载、协作者进出、慢速模式……）一律送进时间线；未知级别也被归成 info 上屏。
2. **缺陷 B（conversation UI）**：`transcript-projector.ts` 的 `frameOf` 把任何级别的 notice
   都投影成 `type: 'error'`，级别在投影层丢掉，warning 与自己的「重试成功」也画成红色报错。

**改法**：

1. **上不上屏只在 engine-omp 判一次**：`noticeLevelOf()` 只认 warning / error，未知值按 info 处理；
   info 级 notice 只记 `logger.debug('omp notice', { source, message })`，不产出时间线 op。
   `auto_retry_end` 成功那一支同样只记 `info` 日志（不再上屏），失败仍是 error notice；
   `auto_retry_start` 与 `auto_retry_end` 失败的形状不变。
2. **投影器收窄**：`LiveProjector.notice()` 的级别参数收成 `'error' | 'warning'`，
   「info 上屏」在类型层面写不出来；`frameOf` 的 `notice` 分支对 info 返回 `null`（兜底，
   正常情况下到不了 UI），warning / error 把级别带进条目；turn 自带 error 也补 `level: 'error'`。
3. **组件按级别选样子**：`ErrorNotice` 新增可选 `level`（缺省 error 保持原样）；warning 换
   `TriangleAlert`、图标颜色降为 `--cp-timeline-quiet-text`，`role=status`，按钮文案说「提示信息」；
   error 保持红色感叹号与 `role=alert`。线与字都不动。

**本轮偏差**：`auto_retry_end` 成功不再上屏（12 页 §9.1 原表为起止各一条 notice）。
理由：info 级提示一律不上屏；上一条 warning 后面紧跟正常回复，已经说明重试成功。
omp 的 info 级 notice 只落 debug 日志，排查时把 Core 日志级别调到 debug 即可看到
（`omp notice`，带 `source`）。

**测试**：

- `packages/engine-omp/src/__tests__/notice.test.ts`（新建）N1–N5：info 只落 debug 日志
  （带 `source`）、warning / error 照常上屏、未知级别不上屏、info 不占帧号（两会话正文帧号完全一致）。
- `packages/engine-omp/src/__tests__/auto-retry.test.ts` N6：`retry_end` 成功不上屏、失败是 error。
- `features/conversation/src/ui/transcript/__tests__/transcript-projector-notice.test.ts`（新建）
  U1–U3：info 不产生条目、warning / error 各带自己的级别。
- `features/conversation/src/ui/components/timeline/__tests__/error-notice.test.tsx`（新建）
  E1–E2：error 是 `data-level="error"` + `role=alert`，warning 是 `data-level="warning"` +
  `role=status`，复制按钮文案各说各的。

**验收**：`bun run  all` 全绿；`bun run protocol:snapshot` 无差异。真机验收（启用 chrome-devtools
MCP 后新建对话不再出现 `xd://: mounted …`；断网触发自动重试时 warning 画灰色三角、最终失败画红色
感叹号、重试成功不出现那一行）与 R-03 / R-05 / R-06 / R-07 / R-08 同例，待真机复核。

## R-10 封条「已处理 N」算错：重启后每轮都不一样，还冒出「<1秒」（2026-10-10）

**来源**：产品负责人交办的截图与缺陷报告 —— 封条那行显示「已处理 <1秒」，
且重启后同几轮的时间每次都不一样。

**根因**（在真机上按 omp 18.5.0 的会话文件复算过）：历史这一条路把
`OmpMessage.timestamp` 当成了**轮的终点**，而 assistant 消息的那一格是这次请求
**发起**的时刻（`AssistantMessage.timestamp` 的定义如此，答完那一刻在
`completedAt` / `timestamp + duration`，见 `pi-ai/src/types.ts`）。于是：

- 「你好 → 你好」这种快轮：终点落在请求发起那一刻，起点是用户消息的提交时刻，
  两个时刻只差 144 毫秒 → 屏幕上就是「已处理 <1秒」（真实 1594 毫秒）；
- 每一轮的终点都少掉最后一次请求的**全部**耗时 —— 重开后与实时看到的数对不上，
  而少掉的那一段随最后一次请求的长短而变，看起来就是「每次都不一样」；
- 段的 `endedAt` 同样写成请求发起时刻，段长恒为 0。

真机复算（`%APPDATA%\Poietica\omp\agent\sessions\...\*.jsonl`，就是报告里那次会话，
取两轮已封口的）：

| 轮 | 旧（`timestamp`） | 新（`completedAt`） | 真值 |
| --- | --- | --- | --- |
| 1「你好」 | 144ms → `<1秒` | 1594ms | 1594ms |
| 2 报告那轮 | 86283ms | 86794ms | 86794ms |

**改法**（`packages/engine-omp/src/projector/history.ts`）：

1. `OmpMessage` 补 `duration` / `completedAt` 两格（只读投影要读的那几个字段，照旧不绑 omp 深层类型）。
2. 新增 `closedAtOf()`：落地时刻优先 `completedAt`，次选 `timestamp + duration`，都没有
   （用户消息、工具结果）才是 `timestamp` 本身。另加 `laterOf()` 归并、`closedIsoOf()` 出串。
3. `screenTurns` 每轮记 `closedAt`（可见段里最晚的落地时刻），封口时用它写 `endedAt`；
   `turnOps` 的 `stepOp` 结束那一头也从 `at` 换成 `closedIsoOf(message)`。
4. 起点不变（用户消息的 `timestamp` 就是真实提交时刻），`isTurnOpen` 那一轮照旧没有终点。

**本轮偏差**：轮终点只由**上屏的段**决定，不把工具结果的落地时刻算进来。
理由：omp 重开会话时会合成工具结果（`createInterruptedToolResults`，`timestamp: Date.now()`，
见 `session/exit-diagnostics.ts`），拿它当终点会把一轮算到「重启那一刻」；
不正常退出那一轮的终点由 omp 合成的 abort assistant 消息承担（`timestamp` = `session_exit` 的
`recordedAt`），同样落在这个口径里。

**测试**：`packages/engine-omp/src/projector/__tests__/history.test.ts` 增三条 ——
终点取「答完那一刻」且段与轮一致、只有 `duration` 时用 `timestamp + duration` 兜底、
快轮不再算成 `<1秒`。原有 106 条投影用例（含两条快照）不破。

**验收**：`bun test packages/engine-omp/src/projector` 109 pass / 0 fail；真机复算见上表。

## R-11 工具卡片的 diff 退化成裸行：没有行号槽、没有增删底色、没有语法色（2026-10-10）

**来源**：产品负责人交办的截图与缺陷报告 —— 工具调用的 diff 视图里每一行只是光秃秃的
正文，行号与增删混作一团，分不出哪一行是删、哪一行是增。

**根因**：P5 迁移时 conversation 不能 import review（功能之间只能经 contract / ui-api /
贡献点协作），于是 conversation 就地留了一份**兜底**行带：`semantics/diff-body.tsx`
只把 `row.text` 逐行印出来（`timeline-tool__diff-row` / `__diff-number` / `__diff-text`），
而这三个类名在全仓**没有任何 CSS**；`semantics/review-port.ts` 的 `paint()` 也是空实现
（原样交回行模型）。于是行号槽、增删底色、词级强调与 shiki 语法色四处全丢 ——
「P6 的 review 经 toolCallRenderers 接真后这一层退成兜底」这一步当时没落地，兜底成了正本。

**改法**：把这条**全仓唯一**的 diff 管线整体提升到 design-system（两个消费者都已经依赖
它，是它们唯一合法的共同低层），conversation 与 review 都从那里取：

1. 文件搬到 `packages/design-system/src/diff/`：`unified-diff.ts`（行模型）、
   `syntax.ts` + `highlighter.ts`（shiki 着色）、`surface.tsx` + `surface.css`（行带
   DiffBody）。两个新子入口：`./diff`（无头、不引 React 与样式，worker 也走它）与
   `./diff/surface`（画的那一半）。
2. review 的五个文件与 conversation 的七个文件改成从 `@poietica/design-system/diff`
   取；conversation 的残骸（`semantics/diff-body.tsx`、`semantics/review-port.ts`、
   `semantics/unified-diff.ts`）删除。
3. 依赖搬家：`diff` / `shiki` / `@tanstack/react-virtual` 从两个 feature 的
   `package.json` 移到 design-system；`bun install` 后 lockfile 只有声明变化。

**为什么进 design-system 正确**：行带的取色与列几何本来就是「产品取值、全仓一份」，
它的 CSS 直接读 design-system 的 token；审查面板与工具抽屉要求的是同一份实现。
放进任一 feature 都会逼出「另一个 feature import 它的 ui」这种越界。无头子路径
（`./diff`）是给 review 的 worker 留的：那里没有 DOM、没有 React，不能吃
`surface.tsx` 的样式副作用。

**测试**：

- `features/conversation/src/ui/components/timeline/__tests__/tool-diff-rows.test.tsx`（新建，
  迁自 legacy）：抽屉画的是 design-system 的行带（`diff-body` / `diff-line`），
  不再有 `timeline-tool__diff-row`；横滚出口只有抽屉那一处；抽屉不画折叠带；
  `tool-call.css` 不重抄增删底色与行号槽。
- `packages/design-system/src/diff/__tests__/paint.test.ts`（新建，迁自 legacy 的
  「diff 一片黑」回归判据）：`computeFile → paint` 之后同一行切出多个带色片段、
  颜色不止一种、拼回来与原文一字不差。
- `packages/design-system/src/diff/__tests__/unified-diff.test.ts`（随迁）：行模型本身
  的四条断言不变。

反向验证：新用例在旧代码上按预期红（抽屉渲染的是 `timeline-tool__diff-row`、
没有 `diff-line`）。真机数据复算（R-10 那次提交的 `history.ts` 改动，34 增 / 8 删）：
97 行、669 个带色片段，DOM 里 `diff-line--added` / `diff-line--removed` 与
`--diff-syntax-light/dark` 都在。

**验收**：`bun run  all` 全绿（1688 pass / 0 fail，216 文件 / 5634 断言）；
`bun run desktop:build` 通过（worker 与主 chunk 都吃到新的子入口）。真机验收
（工具卡片里的编辑调用画出带行号槽、增删底色与语法色的行带）与 R-03 / R-05 / … / R-10
同例，待真机复核。

## R-12 时间线的过程分组：read / execute / 思考合成一条记事，思考整条退成组头一闪（2026-10-10）

**来源**：产品负责人交办的基准截图与口头要求。在此之前，并组只在**同类相邻**的工具调用
之间发生（`groupIn` 按 `ToolKind` 分档），思考（`agent_thought`）是独立的一行：
运行中印末行、落定后可以点开读全文（`thought-card.tsx`）。

**要求与改法**：

1. **read + execute + 思考聚成一条「过程」组**：投影里新增 `process` 档（`PROCESS = {read,
   execute}`），三者相邻且同轮就连成一组；其余类别（edit / write / search …）行为一个字
   没动，思考对它们仍是隔断。
2. **思考从头到尾不落成行**：`TimelineRow` 对 `agent_thought` 直接交白卷。流式中它只借
   过程组的**组头**一闪（末尾非空行，`readThoughtLine(text, 'tail')`，与 `GroupTicker`
   同一套换字动效）；落定之后**整段消失**，历史回放也不出现。
3. **组头文案**（基准截图口径）：两类都有 `已读取文件运行了命令`、只有 read
   `已读取文件`、只有 execute `运行了命令` —— `sayProcessSummary()`。
4. **成员列表封顶**：`.timeline-group__members` 加 `max-block-size:
   var(--cp-timeline-group-max)` 与 `overflow: hidden auto`，戴 `data-scrollable`，
   滚轮仲裁照 `feed/nested-scroll.ts` 的嵌套滚动走（初值 20rem，后由产品调整为 15rem）。
5. **常亮的光只归工具调用**：组头此刻印的是思考时不戴 `timeline-shimmer`（思考靠换字
   刷过，闪完就没），印的是在飞的工具调用时才亮。
6. **成员列表两端那道雾**（产品第二遍追加，参考 `zcode-ref` 的
   `mentions/components/scrollMask.ts`）：还藏着行的那一端用 `mask-image` 线性渐变化开，
   滚到那一端雾就消失 —— 记号说的是「这一端还有没露出来的内容」，不是「这是个滚动盒」。
   判据在 `primitives/use-scroll-mask.ts`（`resolveScrollMaskState` 给 `both / top /
   bottom / none` 四态），画法在 `tool-group.css`，跑道是 `--cp-timeline-group-fade`
   （一行半正文）。只挂两端、中间一律纯黑：一道常驻的整盒渐变会把正常内容也读成雾。
   观测四条来路（滚、盒变形、内容长高、行增删），尺寸变化缺一条雾就会停在错的状态上。
7. **组头换字重做成 zcode 那一套**（产品第三遍追加："动画效果写很糟糕，完全复刻"）：
   先前那版是「把每个变化都当成一次换格来播」—— 模型一个 token 一个 token 地吐字，
   屏幕上却每个变化都翻一次页，眼睛追的是动画不是字。重做之后逐条照 `zcode-ref` 的
   `ToolCallBlocks/QueuedSummaryContent.tsx` + `components/ai-elements/reasoning.tsx`：
   - **按行分格**：`readThoughtLine()` 交出末尾非空行**和它的行号**，行号当这一格的身份。
     同一行继续写 = 原地刷新（不播任何动画，这才是「刷刷刷」）；换行 = 换格，才滚一次。
   - **纵向滚一格**：新句从下方 `0.8em` 升起、旧句往上走掉，`300ms`、`(0.4, 0, 0.2, 1)`，
     随后停 `500ms`。排队上限两格，定时器迟到超过 `250ms` 只播最后一格 —— 中间那几格
     是过去的事，补播会让人在卡顿恢复后看一段过期的排队。
   - **在写的那一格不收省略号**：内容保持自然宽度（`inline-size: max-content`），盒子滚到
     末尾，两端各 16px 化开（`--cp-rolling-line-fade`）。先前用 `layout` 把宽度过渡也
     补间，两条字同时在场时布局每帧重排 —— 那正是这个产品在虚拟器行里最不能碰的东西
     （改写见 `rolling-line.css` 头注：宽度归内容，省略号归落定态）。
   `group-ticker.tsx / .css` 与 `useHeldValue` 整条删除，`RollingLine` 接位。
8. **组头印思考时不要图标**：这一行自己在换字，左边再挂一枚不动的字形是两套说法，
   读起来是「这行在动」而不是「模型在想」。印工具调用时图标照旧（`thinking ? null : …`）。

**偏差（与既有设计的出入，按产品要求执行）**：原先「推理是一行现场、落定后可展开读
全文」的设计（`thought-card.tsx` + `flow-row.css` 的 `.timeline-thought*` +
`use-follow-end.ts` + `--cp-timeline-thought-rule/-max`）**整条移除**：产品明确要求思考
不产生任何可展开 UI，历史回放也不显示。相应地，`virtual-lines.tsx` 的 `measured` 档
只剩 `tool-call-panels` 一个消费者（能力保留，注释更新）。

**测试**：`features/conversation/src/ui/components/timeline/__tests__/process-group.test.tsx`
（新建，14 条）钉住：三类相邻成一条 process 组且 `tools` 里没有思考；单条 read + 一条思考
成组、单条 read 自己不成组；落定纯思考不出现（不落行也不进组内列表）；流式纯思考只出
一条组头且不可展开；两条 edit 仍合组、edit + 思考 + edit 不跨思考合并；组头文案三档；
成员列表封顶与自动滚动；两端那道雾只按四态画（`none` 不挂渐变）；组头印思考时没有
`timeline-row__icon`、印工具时图标仍在。另有
`features/conversation/src/ui/components/primitives/__tests__/scroll-mask.test.ts`（4 条）
钉住四态判据：装得下时两端都没有雾、停在顶端只有下端有雾、停在底端只有上端有雾、
端头那半个像素也算到头；
`features/conversation/src/ui/components/semantics/__tests__/thought-line.test.ts`（6 条）
钉住换字的身份：同一行继续写 key 不变、换行才换 key、末尾空行不挪 key、整段空白给空 key、
CRLF 按同一套行号数。

**验收**：`bun run  all` 全绿（1711 pass / 0 fail，219 文件 / 5695 断言）。
真机验收点（待产品复核）：思考时组头无图标、同一句在原位长字（不翻页）、换行才向上滚
一格、超宽时最后几个字不被省略号吃掉、成员列表到顶出现内部滚动条与两端那道雾、
滚到端头雾消失、历史会话里不再出现思考行。

**修订（2026-10-10，真机复核「宽度还是超出去了」）**：思考那一行铺满整屏，越过了
768px 的阅读栏。根因在两层几何叠出来的：`.timeline-group` 是 `display: grid` 却没定轨道，
隐式 `auto` 轨道按内容的**最大宽度**定；而思考在写的时候内层是 `inline-size: max-content`
（见 `rolling-line.css`），量度又写着 `100%` —— 百分比在固有尺寸计算里当 `auto` 用，
于是轨道被那句话的自然宽度反过来撑开，行自己的 `max-inline-size: min(100%, …)` 没有
确定的 `100%` 可解，拦不住，溢出的字最后只被滚动盒的 `overflow: clip` 截在右缘。
先前量度是 `38rem` 的固定值时轨道撑不开，这个坑才没暴露。

改法两条，各堵一层：`.timeline-group` 加 `grid-template-columns: minmax(0, 1fr)`
把轨道先钉成可用宽，行这时才解得出 `100%`；`[data-measure="prose"]` 的量度从
`100%` 换成 `var(--cp-input-max)`（与 `--cp-grid` 同值，就是阅读栏的宽），给出确定的
上限。测试补两条（量度不再含 `100%`、轨道是 `minmax(0, 1fr)`）。

**验收（修订后）**：`bun run  all` 全绿（1715 pass / 0 fail，219 文件 / 5700 断言）。
真机验收点：思考那一句话右端收在输入框同一条线上，超出的部分在行内滚动、两端化开。

**修订二（2026-10-10，产品复核「深度思考影响分组了」）**：思考原先对 read / execute
以外的档位是隔断（要求 1 里的「别的类别行为一个字没动」），实际跑起来是把本该连成一条的
调用切碎了 —— 截图里五条「抓取 2 个网页」中间夹着思考，于是谁也没并上。产品决定改成
**思考对每一档都透明**：`continuesGroup()` 里 `thought` 与任何档位都相接，`runEnd()`
在思考打头时由**第一件工具**定档（想一会儿再抓、抓完接着想仍是一条；想完换了一档工具
才从这里断开）。`ToolGroupPlan.kind` 相应改为由成员里的第一件工具解出
（`flavorOfTools()`：read / execute → `process`，其余照各自 kind），不再看那一组是谁打头。
思考仍然不进成员列表、落定仍整段消失、单条工具加一条思考仍算一组 —— 这些都没动。

**验收（修订二）**：`bun run  all` 全绿（1717 pass / 0 fail，219 文件 / 5712 断言）。
新增三条投影用例：edit + 思考 + edit 连成一条（原「思考是隔断」用例按新规则改写）；
思考打头由第一件工具定档、同档继续并；换档就断（思考并入左边那一组，不跨到另一种工具）。

## R-10（审查页）目标栏的暂停 / 继续 / 改正文真正下到引擎（2026-10-10）

**来源**：审查页 R-10 `R10.md`（外部输入，不入库）。目标栏上四个按钮只有「清除」真的生效：
暂停、恢复、编辑点了既没有变化也没有报错，任务浮层里的暂停 / 继续同样无效。

**契约变化**：新增 `controls.pauseGoal` / `controls.resumeGoal`，`controls.setGoal` 的
description 收窄成「设置只改正文，进行中 / 已暂停保持不变」；`PROTOCOL_VERSION` 12 → 13，
已重跑 `bun run protocol:snapshot`（快照里只有这两处差异）。

**根因**（四个缺陷叠在一起）：

1. **缺陷 A**：`GoalBar` 的 `mutate` 把动作交给 `onSelect` 之后立刻
   `Promise.resolve({ ok: true })` —— `GoalBarView` 里写好的在途禁用与失败提示永远不会出现。
2. **缺陷 B**：组合根 `onSelectControl` 只认「关掉」那一档，pause / resume / 编辑进来直接
   `return`；任务浮层的暂停 / 继续走同一个出口，一样被丢。
3. **缺陷 C**：契约、`EngineSession` 端口、engine-omp 的会话面都没有暂停 / 继续这两个入口。
4. **缺陷 D**：`applyGoal` 的状态机与 omp 不符 —— 清除也查可用性、清除不摘 `goal` 工具、
   同正文被当成「继续」、完成之后走 `replaceGoal` 会抛。

**改法**（§3.1 的九条原则落成下面这些点）：

1. **每个动作一条自己的路**：暂停 / 继续 / 改正文 / 清除分别对应
   `pauseGoal` / `resumeGoal` / `setGoal(正文)` / `setGoal(null)`，不再借输入框选择器那条
   只表达「开 / 关」的出口。
2. **`setGoal` 只改正文、不改状态**：没有目标或上一个已完成就新建；正文不同就换成新正文
   （omp 的 replace，用量从零记），进行中的仍进行中、已暂停的仍暂停；同正文什么都不做。
   旧的「同正文 = 继续」隐式语义取消，继续有自己的入口。
3. **暂停 = 只停之后，不打断这一轮**（与 omp TUI 的 `#pauseGoalAction` 同口径）：
   `pauseGoal` + 摘掉 `goal` 工具（它自带 `op:'resume'`，留着模型能自己续上）。
   **继续**与 omp RPC 宿主的 `#resume` 同口径：加回 `goal` 工具 + `resumeGoal` +
   正在跑时 steer 一次目标上下文。
4. **幂等**：已暂停再暂停、进行中再继续 → 什么都不做、不发事件；没有可暂停 / 可继续的目标
   → `kernel.not_found`，message 是给人看的中文。
5. **关掉目标模式之后挂着的目标仍停得下、收得掉**：清除与暂停不查 `goal.enabled`；
   设置与继续仍查，关掉时抛 `engine.goal_unavailable`。
6. **`goal` 工具的去留跟着状态走**：只在成员关系真的变了时才调 `setActiveToolsByName`。
7. **UI 不猜状态**：按钮等 RPC 答复，期间 disabled；失败的那句话亮在目标栏的 role=alert 上；
   状态变化只认 `controls.changed` 推回来的快照。
8. **一次改动只报一次控件**：「换暂停目标的正文」在 omp 里是 resume → replace → pause 三步，
   中间不能让屏幕闪一下「进行中」，由 `OmpSession.goalBatch` 压住。
9. **完成之后 `controls.goal` 报 null**：输入框的「目标」开关回到关，可以直接再开；
   `goalSnapshot` 仍如实报 `complete`。

**本轮偏差**：

1. `setGoal` 不再隐含「同正文 = 继续」（同正文落在暂停的目标上什么都不做）。
2. 清除 / 暂停不查 `goal.enabled`（与 `Controls.available` 原注释的口径不同，已把例外写进注释）。
3. 完成之后 `controls.goal` 报 null（原实现完成之后仍报正文，输入框开关收不回来）。

**待决**：Poietica 没有目标续跑驱动 —— 暂停目前只停用量、目标上下文与模型自续，
「一轮结束自动继续」是 R-11 的范围。

**测试**：

- `packages/engine-omp/src/__tests__/goal-actions.test.ts`（新建）：用 omp 真实的 `GoalRuntime`
  钉状态转移 —— G1–G7（暂停 / 继续 / 幂等 / `kernel.not_found` / 关掉模式时的三种行为）、
  E1–E6（改暂停目标的正文、同正文不动、完成后再设、清除摘工具、关掉模式仍能清除）、
  S1–S4（换暂停正文只报一次控件、完成之后 `controls.goal` 为 null、失败也报一次）。
  旧代码上 E1、E3、E4、E5、E6、S3 按预期红（已复核）。
- `packages/engine-testkit/src/conformance.ts`：新增 `C-GOAL-LIFECYCLE`，FakeEngine 与
  OmpEngine 都过。
- `features/conversation/src/core/__tests__/goal-controls.test.ts`（新建）：两条用例在旧代码上
  都红；现在钉住 RPC → handlers → TurnService → FakeEngine，以及 `controls.changed` 通知。
- `features/conversation/src/ui/components/__tests__/goal-bar.test.tsx`（新建）GB1–GB7：
  每个按钮交出的动作、在途禁用、失败提示按目标记账、同正文不发请求、一次只走一个、
  出口违约也不卡 pending。
- `features/conversation/src/ui/__tests__/goal-actions.test.ts`（新建）RA1–RA3：
  四个动作各走各的 RPC、AppError 原样、其余走 `describeFailure` 且永不 reject。

**验收**：`bun run  all` 全绿。真机验收按 R10 §6 的九步走（暂停不打断、浮层同步、
关掉目标模式后的三条行为、完成之后开关能重新打开），与 R-03 / R-05 / … 同例，待真机复核。

## R-11（审查页）目标模式的宿主职责：续跑、重开接回、完成收尾（2026-10-10）

**来源**：审查页 R-11 `R11.md`（外部输入，不入库）。目标模式在 Poietica 上只做到「R-10 的
建 / 续 / 停 / 弃真正下发」，缺了宿主本职：一轮跑完不会自己接着跑（不设目标以外的话，看起来
和普通对话没有区别）；关掉应用再打开，进行中的目标在屏幕上仍报「进行中」（没有任何东西在
推进它）；agent 用 `goal` 工具报完成之后，会话状态里的残留与 `goal` 工具没有收尾；停止键按下
之后被中断那一轮的 `agent_end` 还会排一次续跑。另外，挂技能那一句跑完之后轮头的技能标签会
消失（收尾时 `turnEnd` 现造了一份 `{ kind: 'user' }` 把开轮来源冲掉）。

**根因**：omp 把目标的「持久生命周期」（建 / 续 / 停 / 弃、计量、落盘）放在 `GoalRuntime` 里，
三个宿主共用；而「宿主职责」——`goal` 工具在活动集里的去留、完成 / 放弃之后的收尾、重开会话
时把目标接回来、两轮之间自动续跑——TUI 写在 `InteractiveMode` 里，RPC 宿主写在导出的
`RpcGoalController` 里。Poietica 是第四个宿主，先前一件都没做（R-10 只补了生命周期那半）。

**改法**（不自己实现续跑判断，直接用 omp 导出的 `RpcGoalController`，只做两处接线）：

1. **新 `goal-host.ts`**：一条会话一个 `RpcGoalController`；`controllerSessionOf()` 交给控制器
   的会话除 `promptCustomMessage` 外一律现读现调真会话（getter 不能拷值、类方法不能摘下来裸调）。
   续跑的消息（`customType: 'goal-continuation'`）先问 `OmpSession` 能不能开
   （`reserveContinuation`）；刚由 Poietica 建好、还没跑过一轮时（`awaitingFirstTurn`）让位给
   人的那一句。`allowGoalContinuation()` 只在本会话 override 层加 `goal.continuationModes` 的
   `rpc` 一档（用户删掉 `interactive` 就尊重它），不落盘、不进设置页。
2. **会话层状态机（`session.ts`）**：`goalRun: none / held / reserved / running` —— 控制器决定
   续跑后 `settleIdle` 收进 `held`（状态留在 running，两个续跑轮之间不报 idle），
   `message_start` 认出续跑消息时 `startGoalContinuationTurn()` 开一轮，`finishTurn` 的重复
   `agent_end` 守卫加上 `held`。`cancel()` 先 `stopGoalContinuation()` 再 abort；`resumeGoal()`
   之后 `holdForGoalContinuation()` 立刻把状态切回 running。
3. **事件泵（`omp-session-adapter.ts`）**：每条 omp 事件先过 `pump.goal.observe`（必须先于
   OmpSession 自己的收尾，`agent_end` 时控制器先决定续不续跑）；异常只记 `${type}.goal`。
   打开会话、订阅接上之后再 `goal.reconcile()` —— 会话文件里记着的目标接回来，进行中的一律
   以「已暂停」接回。建 / 续 / 停 / 弃都改走宿主的 `create / resume / pause / drop`。
4. **`plan-goal.ts`**：清除 → `host.drop()`（不查可用性）；没有目标 / 上一个已完成 → 先清残留
   再 `host.create()`；进行中换正文仍走 `runtime.replaceGoal`（正在跑时 steer）；已暂停换正文
   仍走 runtime 的 resume → replace → pause（**不经宿主**，经宿主会排一轮续跑）；
   `pauseGoalMode` / `resumeGoalMode` → `host.pause()` / `host.resume()`；建 / 续预检三道闸
   （设置开着、会话有 `goal` 工具、不在计划模式），计划模式的拒绝文案是中文。
5. **投影（`origin.ts` / `prompt.ts` / `live.ts` / `history.ts`）**：续跑的隐藏消息自开一轮
   （`GOAL_CONTINUATION_ORIGIN`，`{ kind: 'other', payload: { kind: 'system_trigger', name:
   'goal_continuation' } }`，与 transcript upstream 的 `opensOwnTurn` + `mapOrigin` 同一约定），
   轮头不带人话、不画用户气泡；实时与历史共用同一个常量，重开前后轮头一致。`live.ts` 的轮头
   记住开轮时的 origin / prompt，`turnEnd` 原样带回 —— **顺带修好技能标签在轮收尾时丢失**。

**契约**：无变化，`PROTOCOL_VERSION` 保持 13；UI / Core 一行未改。

**测试**：

- `packages/engine-omp/src/__tests__/goal-continuation.test.ts`（新建，omp 真 SDK + mock
  provider）：C1 两轮之间自动续跑（续跑轮上屏、不带人话、状态全程 running、最后只报一次
  idle）、C2 建目标不抢第一轮、C3 暂停（当前轮跑完、之后不续）、C4 停止（中断、回 idle、目标
  已暂停、不再续）；R1 重开接回为「已暂停」、R2 重开后继续立刻续跑、R3 完成收尾写进会话文件
  且重开无目标、R4 重开历史与刚才的时间线一致（轮数 / 来源 / 人话）。
- `goal-actions.test.ts`：夹具换成真 `GoalRuntime` + 真 `RpcGoalController`（经
  `createGoalHost`）；G1–G7 / E1–E6 / S1–S4 全过。
- `plan-goal.test.ts`：目标用例组整块换成 P1–P9（假 session + 假 host 记账）。
- `projector/__tests__/live.test.ts` / `history.test.ts`：加续跑开轮与技能标签保留三条用例；
  `live-legacy` 快照随之更新（技能 origin 现在保留）。
- 既有夹具补齐控制器要读的格（`controls.test.ts`、`event-pump.test.ts`、
  `plan-goal-e2e.test.ts`）；e2e 的假 `goalRuntime.dropGoal` 按 omp 的真相改：先发
  `goal_updated(dropped)` 再清状态（清除的收尾归 runtime，不在 `plan-goal` 里另清一遍）。

**验收**：`bun run  all` 全绿（1762 pass / 0 fail，224 文件 / 5858 断言）。
真机验收（第 6 节七步：自动续跑、暂停、停止、重开接回、完成收尾、计划模式里报中文、
技能标签保留）与 R-03 / R-05 / … 同例，**待真机复核**。

**已知边角**（第 7 节最后一条，本页不修）：会话空闲或 held 时，omp 自动 drain 排队消息
开出的那一轮，Poietica 不会把状态切成 running —— 落地前就有的窄边角，与续跑无关。

## R-13 agent 展示图片走正式工具 show_image（2026-10-10）

**来源**：审查页 R-13 `R-13.md`（外部输入，不入库）。让 agent「画一张 sin 曲线发给我」时，
它会试 file://、data:、本地 http 三条路（净化链与 CSP 全拦）、再翻源码找数据目录、自己算
sha256 往附件目录里复制文件；手工暗路复制进去的文件没有 DB 行（不随对话回收 / 分支，sweep
还会清成裂图），且要求 agent 有数据目录写权限。界面的安全边界（只认
`poietica-asset://attachment/<sha256>`、净化链只放行该 scheme、CSP 不放宽）是对的，缺的是正式入口。

**改法**：

- `features/attachments/src/core-api/index.ts`：`AttachmentsService` 加 `importPaths(paths)` —— 与
  输入框添加附件同一条导入管线，只建 item 行、不挂引用。
- `features/attachments/src/core/index.ts`：provide 时把 `service.importPaths` 一起交出去。
- `features/conversation/src/core/image-tool.ts`（新建）：`show_image(path, caption?)` 工具。
  扩展名白名单与 `INLINE_MIME` 的图片部分同一张；导入前先判类型（`.tiff` / 无扩展名报中文
  错误让模型先转 PNG）；`path.resolve(ctx.cwd, …)` 解析相对路径；导入成功后 retain 到
  `OWNER_KEY(ctx.sessionKey)`（对话名下：删对话 / 分支 / 回收跟着对话走）；交回
  markdown 图片一行（`![alt](previewUrl)`），模型原样放进回复，工具卡同样经 `Prose` 渲染。
- `features/conversation/src/core/index.ts`：setup 里同步注册（工具集在全部 setup 后冻结）。
- `features/conversation/src/ui/components/timeline/prose.tsx`：注释里的资产协议路径改为
  `packages/host-kernel/src/asset-protocol.ts` 与 `features/attachments/src/host/asset-handler.ts`。

**契约**：无变化（`core-api` 是进程内服务接口），`PROTOCOL_VERSION` 不变，界面未改。

**测试**：`features/conversation/src/core/__tests__/image-tool.test.ts`（新建）I1–I6 + M1
（真内核：脚本化引擎调 show_image → sessionKey = threadId、结果是附件协议那一行、文件真的
落在 `attachmentsDir/<sha前2位>/<sha>`）。旧代码上 7 条按预期红（模块不存在）。

**验收**：`bun run  all` 全绿（1769 pass / 0 fail）。真机验收按 R-13 §6 六步走（发图一次成、
重开后仍在、只能写工作区时仍可显示、.tiff 报中文错误、删对话后回收、分支后仍显示），
与 R-03 / R-05 / … 同例，**待真机复核**。

**偏差**：审查页 R-13 的代码块在导出时被破坏 —— 部分模板插值与 markdown 图片结构被
渲染器吃掉（如第 143 行只剩 `!${altOf(...)}`、缺 `[alt](url)` 结构，第 302 / 367 行断言丢了地址段，测试里定义好的
`URL_OF` 夹具却没被用到）。按第 41 行设计说明与 `imported.previewUrl` 的存在复原为：
工具交回 `` `![${altOf(params.caption, imported.name)}](${imported.previewUrl})` ``，
断言相应写成附件协议那一行。

## R-14 自动化 Core：一次性计划、续用对话、超时、通知判定、错过补跑（2026-10-10）

**来源**：审查页 R-14（外部输入，不入库）。自动化是「无人值守」功能，四个现存缺陷会让任务
静默停摆或跑偏：只改标题冲掉模型 / 思考强度 / 姿态；一次送达失败就因 issue 停摆；卡审批
永久占位且不留痕；自动化线程标题被首句覆盖。另有五项能力缺失：一次性计划、错过补跑、
续用同一条对话、运行超时（跑 60 分钟 / 等批准 2 小时）、通知判定与 agent 汇报结论。

**契约变化**：`Schedule` 加 `at`；`AutomationDraft` 加 `threadMode / threadId / notify / catchUp`；
新增 `AutomationPatch`（不带默认值）；`AutomationRun` 加 `trigger: 'catch_up'`、`outcome: 'skipped'`、
`summary / attention`；`ScheduleProblem` 加 `in_past / conflict`；新增错误码
`invalid_thread / not_in_run / forbidden_in_run`；新增通知 `automations.attention`。
`PROTOCOL_VERSION` 13 → 14，已重跑 `bun run protocol:snapshot`。

**改法**：

- **契约**（`features/automations/src/contract/entities.ts` 整文件重写）：字段表只写一次、
  不带默认值，`AutomationPatch` 由它 `.partial()` 得来 —— 修掉 zod 4 在 `.partial()` 里照样套
  `.default()`、只改标题就把 posture / model / thinking 冲回默认的缺陷。agent 工具的
  `automation_update` 参数改用 `AutomationPatch`（此前同样从 `createParams.partial()` 派生）。
- **迁移 v2**：任务表加 `run_at / thread_mode / thread_id / notify / catch_up`；运行表整张重建
  （SQLite 改不了已有列的 CHECK），加 `catch_up / skipped / summary / attention` 与
  `by_thread` 索引，旧行原样搬过去。
- **调度**（`scheduler.ts`）：`repairOnStartup` 对错过的任务 —— 要补跑的记进 `catchUps`、
  不动 `next_run_at`（第一次 tick 以 `catch_up` 跑一次，宁少不多）；不补跑的记一条
  `skipped`「错过」再推进。`tick` 遇到同一任务已在跑时记一条 `skipped` 再推进，不再静默
  跳过；跑完或跳过之后一次性任务自动停用。
- **运行**（`runner.ts`）：`settle()` 是唯一收口点，**不再** `setIssue`（issue 只表示计划本身
  有问题；一次运行失败不再让任务从此不被调度）。轮询搬 `running ↔ awaiting` 之外还累计
  真在跑的时间（60 分钟 → failed）与一段等批准的时间（进入时按策略通知一次，2 小时 → failed）；
  超时先收口再停会话，之后的 `turnSettled(cancelled)` 不会改写结局。续用模式按「对话还在、
  在同一工作区、空闲」才复用，正忙时记一条 `skipped`（不往用户那一轮后面塞话），对话没了
  就新建并重新记下；投给 agent 的话加抬头（任务名 + 为什么此刻在跑）与 `automation_report` 交代。
- **通知判定**：`notice.ts` 的 `noticeOf()` 一个纯函数定规则（never / attention / always，
  cancelled 与 skipped 不通知）；Core 发 `automations.attention`，UI 只在 R-16 转系统通知。
- **服务**（`service.ts`）：`mergePatch` 缺席的键不改，`assertSchedule(…, allowPast)` 让
  「一次性时间已过」在新建 / 改计划 / 重新启用时算错、只改别的字段时不算；新增 `inRun / report`。
- **标题**：`conversation/src/core/thread-service.ts` 建线程时 `titleSource` 改为
  给了标题就是 `user`（此前一律 `pending`，首句提交时按指令摘录改名，盖掉
  「定时任务：<标题> <MM-DD HH:mm>」）。automations 界面只做类型适配：新字段原样带回，
  保存一次不会冲掉 agent 设的值；`skipped` 结局与 `in_past / conflict` 文案补上。
- **时间**：新文件 `time.ts`（`wallTime / isoIn / parseIsoWithOffset / localTimeZone`），
  抬头与线程标题按任务自己的时区读。

**测试**：新建 `r14-model.test.ts`（D1–D8）与 `r14-runs.test.ts`（S1–S12）；`helpers.ts` 加
`fullDraft / buildCore`；老测试按新行为改（`issue` 不再由运行失败写入、并发到点记 `skipped`、
草稿补新字段、标题不再被首句覆盖）。`bun run  all` 全绿（1790 pass / 0 fail）。

**偏差**：无（文件清单与报告 §0 / §3 一致；`docs/refactor-log.md` 之外的文档未动）。真机验收
按 R-14 §6 五步走（旧数据升级、每分钟任务抬头、卡审批留痕、关应用补跑、凭据修好照常运行），
与 R-03 / R-05 / R-13 同例，**待真机复核**。

## R-15 自动化 agent 工具：8 张工具、选工作区与模型、一次性计划、运行中禁止自我繁殖（2026-10-10）

**来源**：审查页 R-15（外部输入，不入库）。定时任务是 agent 的建 / 改入口，但旧工具只能
在当前工作区建、选不了模型与思考档位、猜时区，`automation_update` 还会冲掉设置；没有运行
记录与手动运行工具，且任务运行中的 agent 能再建任务、无人值守地自我繁殖。

**改法**（不改契约，`PROTOCOL_VERSION` 不动）：

- `agent-tools.ts` 整文件重写为 8 张：`automation_options / list / runs / create / update /
  run / delete / report`。参数表**自己定义**（不从 `AutomationDraft` / `AutomationPatch`
  派生，不带 `.default()`，全部 `.describe()` 英文说明），默认值在 `execute` 里补；每个
  `execute` 用 `chinese()` 把非 AppError 转成 `kernel.invalid_params`。
- 可选项一次给全：`now` 是**带时差**的 ISO（用户本机时区）、`timeZone`、当前工作区、
  可用工作区、模型（含显示名）与默认模型、思考档位、权限姿态（每档一句说明）。模型 /
  思考强度经 `engine.draftControls()` 校验，传错时报中文错误并**列出全部可选值**。
- 跨工作区：`workspaceId` 可指定，经 `workspaces.requireUsable` 校验；不传时取当前对话的。
  `thread: 'this'` 要求任务就在这条对话的工作区里，`'continue'` 保住原来的续用对话。
- 修改只带给了的字段（`patchOf` 逐项判 `undefined`），`enabled` 暂停 / 恢复；新建与修改的
  结果带 `upcoming`（接下来 3 次，按任务时区、带时差）。
- 运行中（`service.inRun(ctx.sessionKey)`）拦下 create / update / run / delete
  （`automations.forbidden_in_run`），只放行 options / list / runs / report；
  `automation_report` 只认 `ctx.sessionKey` 上开着的那次运行（`not_in_run`）。
- 结果字段名按 R-16 的工具卡规格（`workspace{id,name}`、`model{provider,id,label}`、
  `lastRun{...}` 等），**不改名**。

**测试**：新建 `features/automations/src/core/__tests__/agent-tools.test.ts`（T1–T12，直接
调 `execute`，引擎只替 `draftControls`）；`module.test.ts` 第一条改成新参数并断言视图与
`upcoming`。旧代码上 13 条按预期红。`biome.json` 的 overrides 只对该测试文件关
`noExplicitAny`（测试按 JSON 字段断言），`features/automations/src/core/tsconfig.json` 的
engine 引用由 `bun run refs` 生成。`bun run all` 全绿（1802 pass / 0 fail）。

**偏差**：无（文件清单与报告 §3 一致，结果字段名与 §3.3 一致）。真机验收按 R-15 §6 七步走
（问可用模型、跨工作区建任务、只改名、明早一次性、立即跑、运行中禁止再建、坏模型报错列
可选值），与 R-03 / R-05 / R-14 同例，**待真机复核**。

## R-16 自动化界面：工具卡重做、模型与思考选择、一次性计划、运行方式、系统通知（2026-10-11）

**来源**：审查页 R-16（外部输入，不入库）。R-14 / R-15 给 Core 与 agent 工具的能力在界面上
看不见、改不了；对话里的工具卡只有一行字；运行需要人时没有系统通知，而 conversation 自己
那一对通知会对定时任务的对话重复发。

**改法**（不改契约，`PROTOCOL_VERSION` 不动）：

- **工具卡**：新增 `ui/tool-card-model.ts` 的纯函数 `toolCardOf(toolName, args, result, status)`
  读 R-15 §3.3 的结果字段（`nextRunAt / workspace / model / upcoming / lastRun` 等），
  `automation-tool-card.tsx` 只画它的结果；折叠行与摊开的纸全部借时间线的
  `.timeline-row` / `.timeline-tool__body` 与令牌，颜色只给状态点、失败、「需要你关注」。
  卡片动作（打开任务 / 立即运行 / 打开对话）经 `ToolCardDeps` 由 `ui/index.tsx` 装配。
- **编辑器**：`AutomationComposer` 补模型与思考强度两颗胶囊，可选项读 conversation 的
  `controls.draft`（`api.draftControls`，只读 RPC）；`AutomationScheduleField` 的值由
  `string | null` 换成 `{cron, at}` 并加「一次」档（原生 `datetime-local`，默认明天 09:00）；
  新增「运行方式」一栏（对话 / 通知 / 错过补跑）与 `threadId` 语义；编辑已有任务保留任务
  自己的时区（只有缺省才落本机）。
- **列表与历史**：卡片底行写整份计划（一次性写「一次 · MM-DD HH:mm」，跑完写「已结束」），
  指令下方显示上次运行的结论（attention 浅黄底）；历史行加「手动 / 补跑」标签与「需要
  关注」，结论在前、系统消息在后。
- **系统通知**：automations 的 UI 订阅 `automations.attention` 并原样转给 platform 的
  `notify.show`（判规则仍在 Core 的 `notice.ts`）；`dependsOn` 加 `'platform'`，
  新增 `@poietica/feature-platform` 依赖。conversation 的 `notify()` 对
  `origin === 'automation'` 的对话直接返回，避免同一件事响两次、「从不通知」的任务也响。
- **侧栏**：定时任务开的对话行首放一枚淡色 `AlarmClock`（运行中让给加载指示）。

**测试**：新建 `ui/__tests__/tool-card-model.test.ts`（C1–C11，工具卡读法与
`datetime-local` 往返、默认时刻、`describePlan`）；`automations-store.test.ts` 的假 api
补 `onAttention` / `draftControls`。`bun run all` 全绿（1813 pass / 0 fail）。

**偏差**：无（文件清单与报告 §3 一致，工具卡字段名按 R-15 §3.3）。真机验收按 R-16 §6
八步走（建用非默认模型与深度思考的任务、改名、列任务看记录、汇报与通知、从不通知、
编辑器模型 / 一次性 / 运行方式、侧栏闹钟、坏模型报错），与 R-03 / R-05 / R-14 / R-15 同例，
**待真机复核**。

## R-17 Mermaid 图：从固定画布改成随栏宽的自适应图（2026-10-11）

**来源**：产品负责人口头交办（不入库）。原来的图是一块固定 26rem 高的画布，带平移、
缩放、适应页面三组控件，以及 `neutral` 主题的固定配色 —— 深色对话底（`#181818`）上
图自带浅色底与近黑连线，观感像贴了一块木板。

**改法**：

1. **面板**：`timeline.css` 去掉底色、圆角、裁剪与固定高度；舞台只留「宽度 100%」。
   图按栏宽适配、高度随 viewBox 比例，窄图不被拉大（svg 自带的 `max-width` 是自然宽）。
2. **交互**：删掉拖拽、滚轮缩放、放大 / 缩小 / 适应页面三枚按钮与 `useCanvas` /
   `useWheelZoom`。`ground()` 只摘掉引擎写的 `width` / `height` 两个属性并置
   `width:100%; height:auto`；源码视图自己保留 26rem 上限并在内部滚动。
3. **主题**：`neutral` → `base`（五个内置主题里唯一把颜色交给 `themeVariables` 的），
   颜色由新增的 `diagram-theme.ts` 从设计令牌解析：节点面 `--ui-secondary`、节点框
   `--ui-popover-trigger-frame`、连线与箭头 `--cp-ink-muted`、文字
   `--cp-timeline-body-ink`、分支标签底 `--ui-background`。全部不用主色，一张流程图
   在对话里不读成「重点」。
4. **归一两次**：mermaid 只认具体颜色（喂 `var(--x)` 抛 Unsupported color format），
   而 `getComputedStyle` 在浅色下交回 `oklch()` / `color()`（mermaid 也不认）—— 所以
   先经探针元素求值、再用 1×1 画布读回像素，交出去的永远是 `rgb()`/`rgba()`。
5. **跟随主题**：`useInks` 用 `MutationObserver` 盯 `documentElement` 的 `data-theme`，
   变了就重新解析并重画；引擎每次渲染前重设一次 `themeVariables`（它是模块级单例）。
   注意这一步必须把整份 `CONFIG` 一起递进去：上游插件的 `initialize` 会用自己的默认配置
   （`theme: 'default'`）重新铺一遍，只递 `themeVariables` 会把 `base` 顶掉，画出来仍是
   `default` 那套写死的紫。
6. **圆角**：mermaid 把节点 `rx` 写死成 0，CSS 用 `.node rect` / `.cluster rect` 补
   `--ui-radius-lg`。这一条走 CSS 不走 themeVariables，因为官方没开这个口子。

**测试**：无新增单测（纯 UI 外观与交互删减；`diagram-theme.ts` 依赖真实样式引擎，
happy-dom 不解析设计令牌与 oklch）。改动经 Chromium 实渲染核对深浅两套主题的取色与
可读性，`bun run all` 全绿（1813 pass / 0 fail）。

**偏差**：无。真机验收：浅色 / 深色主题各看一张流程图（节点面、框线、连线、分支标签
可读），切主题当场变色，长宽比不同的图都只按宽度适配、不加滚动条、不可拖拽，看图 /
看源码两个视图来回切时下方内容不跳。**待真机复核**。

## R-18 对话内组件 show_widget：现写 HTML 或嵌本机开发页，沙箱隔离、跟随主题、回传操作（2026-10-11）

**来源**：产品负责人交办（不入库）。agent 原来只能在对话里写文字、贴图、画 mermaid，
给不出能点、能拖、能比较的东西。R-18 给 agent 加一个 `show_widget` 工具：现写一份
HTML/CSS/JS（可从公共 npm CDN 载 d3 / chart.js / three），或嵌本机开发服务器的真页面
（`http://localhost:5173/…`）。

**为什么不用 `srcdoc`**：主窗口 CSP 是 `script-src 'self'`。`srcdoc`、`about:blank`、
`blob:` 的 iframe **继承父文档的 CSP**，模型写的内联脚本一行都跑不了；为它放开主窗口的
CSP 等于给整个渲染进程开口子。所以组件跑在一个独立来源的外壳文档里：
`poietica-asset://widget/shell-1.html`，由 conversation 新增的 host 模块经资源协议返回，
**自带自己的 CSP 响应头**。外壳加载后发 `poietica:ready`，UI 回
`poietica:render {html, css, theme, bare}`，外壳把令牌、预置样式、小桥脚本拼到组件 HTML
前面，`document.open/write` 成组件文档（CSP 头仍然生效）。外壳文件名带版本号：
资源协议统一回 `immutable` 缓存头，外壳一改就换名字。

**三层隔离**：

1. **iframe sandbox**：html 来源只给 `allow-scripts allow-forms`，**没有
   `allow-same-origin`** —— 组件是不透明来源，拿不到 `parent.document`（SecurityError）、
   Cookie、主窗口存储与 preload API，不能弹窗、不能顶层跳转。
2. **外壳 CSP**：`default-src 'none'`；脚本 / 样式 / 字体 / connect 只多放 4 个公共
   CDN；图片与媒体只认 `data: blob:`；`frame-src / object-src / base-uri / form-action`
   全 `'none'`。组件能用库，但 fetch、外链图片、WebSocket、表单外提都被拦，数据出不去。
3. **小桥**：UI 只收来自这个 iframe 的 6 种消息（ready / height / send / draft / open /
   error），字段类型不对当没收到；send / draft / open 要求
   `document.activeElement === iframe`（用户刚在组件里点过或按过键）；send 一秒节流；
   文本截 4000 字；open 只放 http(s) 与 mailto，走 `shell.openExternal`。

url 来源给 `allow-scripts allow-same-origin allow-forms allow-modals`（用户自己的开发页
需要存储和 HMR），它与 Poietica 不同源所以安全；**唯一的例外是 Poietica 自己的 dev
server** —— UI 发现同源直接拒绝显示。工具侧只收 `localhost / 127.0.0.1` 的 http(s)、
不收带口令的地址，并先探活一次（4 秒超时；连不上 / ≥400 当场把错误交还模型）。

**其余改动**：

1. **主题**：24 个令牌变量（`WIDGET_TOKEN_NAMES` / `WIDGET_TOKEN_SOURCES` 一一对应，
   有单测钉住），UI 在 iframe 元素上 `getComputedStyle` 求值后拼 `:root{…}`；值里含
   `; { } <` 这类能拆开样式表的字符整格丢掉。MutationObserver 盯 `html[data-theme]`
   （切主题只重推令牌，组件不重跑，输入内容不丢）。
2. **预置样式**全部包在 `:where()` 里（特异性为 0），模型自己写样式都压得过；
   `bare: true` 时只留令牌与小桥。组件文档背景透明，iframe 不写 `color-scheme`。
3. **尺寸**：高度靠 ResizeObserver + `DOMContentLoaded / load` 直报（不用 rAF：
   Chromium 会停掉不可见跨源 iframe 的渲染循环）；首次报高前高 1px、`opacity: 0`；
   最小 24px、封顶 80vh；模型给 `height`（80–2000）就固定；url 来源默认 560px。
4. **时间线**：`show_widget` 不并进「过程」组、落定后不折叠（它是答复的一部分）；
   失败的那次照常归过程。
5. **主窗口 CSP** 只改 `frame-src`：加 `poietica-asset://widget` 与本机开发服务器，
   `script-src` 一个字没动。

**契约**：只新增常量文件 `contract/widget.ts`，不加 RPC 方法、不改已有形状，
**不提升** `PROTOCOL_VERSION`。

**测试**：新增 4 个文件共 22 例（W1–W8 + M1 真内核、S1–S3 外壳与 CSP、B1–B6 小桥纯
逻辑、时间线 4 例）；先写测试在旧代码上失败再实现。`bun run all` 全绿
（1835 pass / 0 fail，较 R-17 的 1813 新增 22）。

**偏差**：无。第 6 节真机验收（浅色 / 深色各一遍，Windows `bun run dev`）**尚未执行**，
留待人工逐条走。沙箱侧已在 Chromium 用真 `WIDGET_SHELL_HTML` + `WIDGET_CSP` 验收过
高度自适应、程序化 send 被拦、点击后生效与节流、localStorage 垫片、切主题不重跑、
`parent.document` SecurityError、fetch 被 CSP 拦、Chart.js 从 jsdelivr 加载。

### R-18 执行偏差（2026-10-11）

1. **闸门脚本名**：R-18 第 4 节的第 7 步写 `bun run check`，但本仓 `package.json` 里没有
   `check` 脚本，唯一的准入闸门是 `bun run all`（= typecheck + lint + test）。按后者执行。
2. **`core:build` 未在本机重跑**：执行时本机已有一个 9:44 启动的 `bun run dev` 实例，
   `poietica-core.exe` 正锁着 `apps/core/dist`，构建脚本删旧产物时报
   `EPERM: operation not permitted, rm 'apps/core/dist'`。本次改动只触及 Core 侧一个
   工具注册（`registerWidgetTool`）与既有包，未改构建配置 / 依赖装配 / 环境或路径，故
   未停掉用户的运行实例；`bun run all`（含 Core 相关单测，含走真内核的 M1 用例）全绿。
   涉及 R-18 的 Core 产物与隔离自检（`core:probe`）留待关闭 `bun run dev` 后补跑。
3. 方案正文提到 registry 里 `tools.register` 的既有形态未变；`show_widget` 与
   `show_image` 同点注册，不涉及 `PROTOCOL_VERSION` 与协议快照。

## R-12（审查页）排队条的插话 / 撤回点了没反应：入口页建的队列把键 `''` 关在闭包里（2026-10-11）

**现象**：从首页（入口那一格）发第一句话开出新对话，AI 回复时再发一句进入排队，
排队条上「插话」「撤回」两枚键点了都没反应，也没有横幅；从侧栏打开的旧对话正常。

**根因**：输入框只挂一处，排队条跟着它，所以首页渲染时 `useAssistantSession` 就调了
`transcripts.queue('')`。`queue()` 建 `MessageQueue` 时把 `target = ''` 关进了四个闭包
（withdraw / move / setModes / failed）。第一句话发出后 `#migrate('', 't-new')` 把这份
MessageQueue **原对象**挪到 `'t-new'` 下（屏幕订阅的是它，不能换对象），快照照收、排队条
照画；但写动作仍拿闭包里的 `''` 去 `#requirePort('')` —— 入口那一格**故意不记别名**，于是
抛「这个界面还没有接上助手会话。」，失败又被 `failed('')` 记在入口那一格上，对话里看不见。

**改法**：不换对象，只让队列的归属可迁移。`TranscriptStore` 新增
`#queueHomes = new WeakMap<MessageQueue, { key: string }>()`，写动作与失败横幅**在调用时**
按 `home.key` 找端口；`#migrate` 挪队列时顺手把 `home.key` 改成新号。

**测试**：`transcript-store.test.ts` 新增 Q1–Q3（入口页开的对话）。旧代码 Q1、Q3 失败；
修后 `bun test features/conversation` 280 pass / 0 fail，`bun run all` 全绿
（1838 pass / 0 fail，较 R-18 的 1835 新增 3）。

**偏差**：无。第 7 节真机验收（Windows `bun run dev`，含首页开对话后撤回 / 插话、
已取走的条目失败横幅落在对话里、旧对话回归、第二条新对话不串）留待人工执行。

## P-01 长对话来回滚动：离屏行被卸载，回来时整段正文重新解析、图表重新画（2026-10-11）

**来源**：`Project Refactoring Plan/P-01 长对话来回滚动…md`（外部输入，不入库）。

**现状复核**（方案 §2 的证据表逐条对过，行号已随 R-17 / R-18 漂移，结论不变）：
`useVirtualizer` 没有自定义 `rangeExtractor`，渲染集合就是「视口 ± overscan」的连续区间；
不在集合里的行由 `items.map` 卸掉整棵子树，行内的 `Streamdown` 解析缓存与
`useDiagramSvg` 的画图结果一起丢；`diagram.tsx` 里 `showCode = asCode || graphic === undefined`
决定「先源码面板、再换图」的一帧，行高因此变两次；`shouldAdjustScrollPositionOnItemSizeChange`
又把视口之上那次长高补进 `scrollTop`，屏幕上是往回滚时被推一下。

**改法**（严格按方案 §4 / §5，两个提交的量）：

1. **A 渲染集合 = 默认区间 ∪ 最近看过的行**：新增 `feed/keep-alive.ts`（`KeepAlive` 按
   条目 id 记 LRU + 纯函数 `mergeRange`）。滚动区加 `KEEP_ALIVE_ROWS = 80` 与
   `rangeExtractor`：`defaultRangeExtractor(range)` 先 touch 一遍、再把常驻集合按
   `feed.rowOf(id)` 换回下标，并集去重后**升序**交回（`rowAtAnchor` 的二分与虚拟器
   自己的遍历都假定起点单调）。`spansRef.current = items` 的写入逻辑一个字没动 ——
   常驻行要么远在上方、要么远在下方，视口所在的连续区间一定盖住锚点，二分结果不变
   （已在 `rowAtAnchor` 调用处写清这条前提）。
2. **B Mermaid 产物出模块级缓存**：新增 `timeline/diagram-cache.ts`（`svgKey` = 颜色 +
   源码；SVG 字符串 LRU，64 条 / 400 万字符双上限；`inksByTheme` 按主题留一套颜色）。
   `diagram.tsx` 把「DOMParser 解析 + 找 svg 根 + invariant」抽成 `parseSvg`；
   `useInks` 的初值改成 `cachedInks(currentTheme())`；`useDiagramSvg` 的 state 从
   `SVGSVGElement | undefined` 换成 `{key, svg} | undefined`，初值走**只读**的 `peekSvg`
   （渲染期不许有副作用），effect 里命中就 `setFailure(undefined)` 并补记一次使用
   （`cachedSvg`），**不再调 `diagramEngine()`**；未命中才走原路径，画成后 `keepSvg`。
   失败不缓存。`Diagram` 组件的 JSX、类名与文案一字未改。

**明确不做**（方案 §4.3）：不改 `Prose` 的 `mode`、不加 `content-visibility`、不调大
`OVERSCAN_SETTLED`、不动 `TimelineSeat` / `TimelineRow` 的 memo 结构。

**测试**（先写、在旧代码上确认红，再实现）：

- `feed/__tests__/keep-alive.test.ts`（新，7 例）：淘汰顺序、touch 刷新最近使用、
  `size ≤ capacity`、`mergeRange` 的升序 / 去重 / 越界丢弃 / 非字符串 key 不常驻。
- `timeline/__tests__/diagram-cache.test.ts`（新，7 例）：条数上限、字符上限、
  命中刷新最近使用、同键重写不挤掉邻居、`inksKey` 键序无关、颜色 / 源码任一不同即不命中、
  按主题各留一份颜色。
- `timeline/__tests__/diagram-remount.test.tsx`（新，3 例 ❗）：引擎换替身计数、取色换固定色。
  D1 首挂载画一次（首帧仍是源码面板）、卸载后重挂载**首帧就是图**且引擎仍只画一次、
  `initialize` 也只跑一次；D2 换源码照常重画且结果进缓存；D3 `isIncomplete` 期间不画。
  旧代码上 D1、D2 红（首帧 `data-view="code"`、`render` 被调用 2 次），D3 绿（回归）。
- 滚动区本身**没有**写依赖真实几何的测试（happy-dom 没有布局），逻辑由上面两条纯函数覆盖
  （方案 §6.4 的推荐做法），`extractRange` 的接线由类型与上面这条重挂载用例兜。

**验收**：`bun run all` 全绿（1855 pass / 0 fail，236 文件，较 R-12 的 1838 新增 17）。
`bun run typecheck` / `bun run lint`（biome + 三条自定义闸门 + depcruise）各自通过。

**偏差**：无契约、无依赖、无协议变更（`defaultRangeExtractor` 与 `Range` 由
`@tanstack/react-virtual` 自身再导出，未新增 `@tanstack/virtual-core` 依赖）。
方案 §6.3 提到的「happy-dom 读不到令牌」确实成立：`getComputedStyle` 交回空串、
Canvas 2d 上下文为 `null`，所以那条用例把 `diagram-theme` 换成固定色 —— 方案原文允许。
另记一条测试环境事实：happy-dom 只按命名空间把 `DOMParser` 的内容建成 SVG 元素，
替身交回的 svg 必须带 `xmlns`，否则 `ground()` 读不到 `viewBox`（只关测试，不关产品）。

**待真机复核**（方案 §7，需 Windows 桌面实例与真实 Mermaid）：60 轮以上的长对话里
从底部上滚 5 屏再滚回底部 —— 回滚阶段 `parseMarkdownIntoBlocks` / unified / Mermaid
`render` 的调用次数接近 0、无 >50ms 长任务、图表行不再出现「先源码后图」的一帧、
React Profiler 里回滚阶段 `Streamdown` 不出现 mount、200 轮对话来回滚 1 分钟 DOM 节点数
稳定在平台期。若 DOM 节点数过高，按方案 §8 把 `KEEP_ALIVE_ROWS` 降到 40（不要改成按像素算）。

## CI-01 GitHub Actions 持续全红：短名比较的环境折叠 + 去抖测试赌真实时钟（2026-10-11）

**来源**：产品负责人询问「能不能看 GitHub CI 的结果」时发现，自 2026-10-10 起每次 push
的 `Check` 全红（`core-build` 因 `needs: check` 从未跑起来），22 fail / 18 error。

**根因**（两处，均只在 runner 上成立，本地永远绿）：

1. **8.3 短名 vs 长名的字符串前缀比较**（主因，18 个 unhandled error 的真正来源）。
   `omp-home.ts` 的守卫用 `path.resolve(root).toLowerCase().startsWith(path.resolve(home).toLowerCase())`
   判断「临时目录位于用户目录之下」；runner 上 `tmpdir()` 是 8.3 短名
   `C:\Users\RUNNER~1\AppData\Local\Temp`、`homedir()` 是长名 `C:\Users\runneradmin`，
   前缀必然对不上 → 在模块求值时 throw → 每个 `import './omp-home'` 的测试文件全员躺枪
   （压缩标记那两条经夹具动态 import 也落进同一格）。本地用户名「陈小建」无短名，复现不了。
   修复：两侧先 `realpathSync.native` 归一到长名再比（`omp-home.ts`；判定改用仓库现成的
   `isInside`）。T-ISO-2 同因：`isolation.test.ts` 里 `mkdtempSync` 的 `POIETICA_TEST_ROOT`
   也先归一，否则夹具里 `prepareIsolation` 的 `isolatedConfigDir` 同样误判越界。
2. **`saveDebounced` 测试赌 20ms 去抖 + 固定 `Bun.sleep(50)`**：CI 冷盘上原子写
   （临时文件 → fsync → 改名）没跑完就断言，偶发 ENOENT（同一条在旧 run 绿、新 run 红，
   典型 flake）。修复：假钟 `vi.advanceTimersByTime` 推进去抖窗口 + `await doc.flush()`
   等写入链收口，不再赌真实磁盘速度。

**未改**：`.github/workflows` 里 `bun run  all` 的双空格是仓库一贯写法（`package.json` 的
`all` 脚本、AGENTS.md 均如此，bun 照常执行），非笔误。

**验证**：local `bun run all` 全绿（1855 pass / 0 fail）；短名病根用本机真实短名
（`C:\PROGRA~1` / `C:\Users\ADMINI~1`）复现，旧逻辑 false、归一后 true；push 后 CI 绿。

**环境事实**（记下来给后来者）：GitHub Actions 的 Windows runner 上
`os.tmpdir()` 返回 8.3 短名而 `os.homedir()` 返回长名 —— 任何「临时目录在用户目录之下」
这类字符串比较在 runner 上都会翻车；跨这两者的路径判断一律先 `realpathSync.native`。

## P-02 对话在跑时最小化、切回卡死：视图通知按帧合并、不可见时不渲染（2026-10-11）

**来源**：`Project Refactoring Plan/P-02.md`（外部输入，不入库）。

**现状复核**（方案 §2 的证据链逐条对过，行号已漂移、结论不变）：Core 按 16ms 合批发
`timeline.ops`；每批经 `TranscriptReplica.#apply`（每批先拍一张回滚快照）→ `#publish`
（投影 + 目录）→ `#fire` 同步叫醒订阅者；`useSlice` 的 `useSyncExternalStore` 被
React 强制走同步车道，来一批就完整渲染一次；提交后的 layout effect 还调
`virtualizer.scrollToEnd()` 强制布局。窗口最小化时 rAF 停跑，但 IPC 照收、渲染照做，
切回时把积压逐条重放 —— 与「最小化再点回来卡死」「长回复后半段黏」吻合。

**改法**（严格按方案 §4 / §5，与旧版方案的差别见其 §4 复核表）：

1. **新增 `ui/transcript/view-frames.ts`**：`createViewFrames(frame)` 返回
   `{ schedule, forget }`，脏集合 + 一帧一次；`animationFrame` 在**调用时**查全局
   `requestAnimationFrame`（测试可临时替换），没有就退到 16ms 定时器。
   全应用共用一个 `VIEW_FRAMES`。
2. **`useSlice` 接上闸门**：`transcripts.subscribe(key, () => VIEW_FRAMES.schedule(onChange))`，
   退订时 `off()` + `VIEW_FRAMES.forget(onChange)`；`read` 不动 —— 帧来时读到的就是
   最新快照。事实订阅（`waitForTerminal` 在 store 内部、`subscribeRunning`、系统通知）
   保持同步，不受闸门影响。改后 React 侧 `transcripts.subscribe(` 只剩 `useSlice` 一处。
3. **删掉每批的回滚快照**（`transcript-replica.ts` `#apply`）：`applyOps` 不修改输入状态、
   `AgentReducer.receive` 在缺口时根本没给 `#state` 赋值，回滚是白拷五张侧表。
   `packages/transcript` 的 TL-5b 钉住这条前提。

**明确不做**（方案 §5）：不改 `TranscriptStore` 的订阅 / 迁移 / 释放逻辑；不用
`startTransition` / `useDeferredValue`；不设 `backgroundThrottling: false`；不在 Host/Core
侧「窗口隐藏就暂停推送」；本页不改投影时机（留 P-04）。

**测试**（先写、在旧代码上确认红，再实现）：

- `components/transcript/__tests__/use-slice-frames.test.tsx`（新，3 例 ❗）：F1 帧不来时
  50 批数据 0 次提交、来一帧恰好 1 次且是最新（旧代码 `Received: 50`）；F2 同帧 3 批
  只提交 1 次（旧代码 `Received: 3`）；F3 等帧期间卸载订阅退干净、帧来了不出错。
- `ui/transcript/__tests__/view-frames.test.ts`（新，5 例）：V1 重复 schedule 只请求一帧
  只叫一次；V2 多订阅者共用一帧；V3 forget 后不再叫、全撤时取消帧；V4 回调里再 schedule
  排到下一帧不递归；V5 帧不来就一直不叫。
- `packages/transcript/src/__tests__/timeline.test.ts` TL-5b（新，旧代码上也通过，是删
  快照的前提保护网）：半批合法半批缺口时整批作废、输入状态原样不动。

**验收**：`bun run typecheck` / `bun run lint` 各自通过；`bun test features/conversation
packages/transcript` **324 pass / 0 fail**（基线 315，新增 9）；`bun run  all` 全绿
（1864 pass / 0 fail，较 P-01 的 1855 新增 9）。

**偏差**：无契约、无依赖、无协议变更，无数据迁移；回滚即整笔 revert。
方案 §6 的 diff 中 `transcript-replica.ts` 的缩进/注释按仓库现状落位，其余一字不差。

**待真机复核**（方案 §8，需 Windows 桌面实例）：≥50 轮对话发长回复后立即最小化
2 分钟再还原 —— 第一帧即最新内容、1 秒内可交互、Host 日志无 `renderer unresponsive`；
前台长回复 React commit 次数 ≤ 帧数且都落在 Animation Frame 之后；最小化期间渲染
进程 CPU 明显下降、系统通知照常、`waitForTerminal` 自动化任务正常落定；入口页新开
一条对话发第一句屏幕正常跟着走（别名迁移未受影响）。

## P-04 长对话流式：投影的「引用稳定」按通道记账、不可变页只扫一次（2026-10-11）

**来源**：`Project Refactoring Plan/P-04.md`（外部输入，不入库）。

**现状复核**（方案 §2 的证据链逐条对过，行号已漂移、结论不变）：

1. `transcript-projector.ts` 的 `stableSealed` / `outlineOf` 各只有一个**模块级**槽位
   （`sealedCache` / `outlineCache`）。主对话、每个子代理、后台在跑的对话都走同一个
   `projectTranscript` / `outlineOf`（`transcript-store.ts` `#publish`），两条通道交替
   发布就互相覆盖。presentation 的 `PREFIX` WeakMap 以 `sealed` 数组为键、minimap 以
   `outline` 数组为键做 memo，引用一换就整段前缀重建、整列按钮重渲。
2. 旧版方案没发现的第二种情况：`OUTLINE_MARKS` 按 turn **对象身份**记账，而流式每批都会
   把在跑那一轮换成新对象（上游结构共享），于是单通道下 `outline` 也每批换新 —— 注释里
   「未封口时复用」的意图从来没生效过。
3. 三条每批 / 每帧的全量扫描：store 的 `stampedTurns`（`#put` 每批，`withSubmissionRows`
   里还多扫一遍）、`timeline-queries.currentTodos`、`todo-panel.delegateCalls`。已封口页
   不可变、身份稳定，扫一遍的结果按页记账即可。

**改法**（严格按方案 §5 / §6，与旧版方案的差别见其 §4 复核表）：

1. **`ProjectionMemo` 按通道持有**（`transcript-projector.ts`）：`projectTranscript(snapshot, memo)`、
   `outlineOf(snapshot, memo)` 的 memo 改为**必填**（不给默认值，否则旧 bug 留给下一个调用者）；
   删掉模块级 `let sealedCache` / `let outlineCache`。
2. **在跑那一轮的标记跨批沿用**：`carriedMark(turn, previous)` —— 只在这个 turn 对象没见过
   且这一轮未封口时，沿用它在这条通道上一份目录同一位置、号 / admissionId / 题面都对得上的
   标记；封口那一批一定重算（M4 钉住），题面变了（reset）不认（M5）。
3. **store 的备忘录挂在副本对象上**：`#memos = new WeakMap<TranscriptReplica, Map<agentId, ProjectionMemo>>`
   （`#memoOf(owner, agentId)`）。副本被换掉或释放后备忘录随它回收，**不需要任何删除路径**；
   别名迁移不用搬（迁的是键，副本还是那一个）。
4. **新增 `ui/timeline/page-memo.ts` 的 `sealedPageMemo(compute)`**：已封口页按对象身份记一次，
   值包一层 `{ value }` 让 `null` 也能被记住；`T extends object | null` 挡住原始值。
   只给 `sealed` 里的页用 —— `active` 每批都是新对象，记它只会白填 WeakMap。
5. **时间线查询改造**（`timeline-queries.ts`）：`latestTodosIn` + `settledTodosOf` 重写
   `currentTodos`（判据与旧实现逐条等价；页号撞上 active 时不走缓存、照原样现算）；
   `stampedTurns` 从 store 搬来改名 `clientTurnIdsOf`；任务面板的 `delegateCalls` 搬来改名
   `delegateCallsOf`（纯时间线查询，本就该在这里，也才测得到）。
6. **收口**：`withSubmissionRows` 里那第二遍扫描直接删掉 —— 唯一调用方 `#put` 刚把这一份
   时间线里带号的真实轮并进 `seen`（`stampedTurns` 判的是 `stripped`，剔掉的提交条目本身
   不带号），`seen` 因此改为必填参数；`knownPromptIds` 的调用抽成 `remainingSubmissions`，
   「没有任何一条带 promptId」时连号表都不建。

**行为变化**（方案 §5 表）：minimap 悬停卡片看**正在跑的那一轮**不再逐字刷新，显示这一轮
第一次被看到时的回复，封口那一批立刻换成完整回复 —— 这是 `OUTLINE_MARKS` 注释里写明的既定
行为；正在跑的那一轮主视图本来就在实时显示，没有信息损失。待办面板、任务面板「智能体」一节、
提交气泡的替换判据与结果完全不变。

**测试**（先写、在旧代码上确认红，再实现）：

- `ui/transcript/__tests__/transcript-projector-memo.test.ts`（新，7 例）：M1 / M2 两通道交替
  各自稳定、M3 单通道流式 outline 稳定（旧代码上这 3 例失败，`Received: serializes to the
  same string`）；M4 封口重算拿到完整回复、M5 reset 不沿用、M6 又封口一轮换新、M7 边界。
- `ui/timeline/__tests__/current-todos-memo.test.ts`（新，2 例）：Q1 已封口页 `items` 问两次
  只读一次（旧代码 `[2, 2, 2]`，红）；Q2 判据防回归。
- `ui/timeline/__tests__/timeline-scans-memo.test.ts`（新，2 例）：Q3 `clientTurnIdsOf` 收齐
  两处、封口页只读一次；Q4 `delegateCallsOf` 计数与顺序、封口页只读一次。
- `transcript-projector-notice.test.ts`：既有调用补 `createProjectionMemo()`。

**微基准**（方案 §8 脚本，量完删除、未提交；同一台机器，300 批）：

| 场景 | 指标 | 改前 | 改后 |
| --- | --- | --- | --- |
| 1000 轮，双通道交替 | `sealed` 命中 | 0/300 | 299/300 |
|  | `outline` 命中 | 0/300 | 299/300 |
|  | 提交号扫描 | 174µs | 13µs |
|  | `currentTodos` | 113µs | 8µs |
|  | `selectPresentation` | 305µs | 86µs |
| 1000 轮，单通道 | `outline` 命中 | 0/300 | 299/300 |
|  | 提交号扫描 / `currentTodos` | 121µs / 82µs | 12µs / 6µs |
| 200 轮，双通道交替 | `sealed` / `outline` 命中 | 0/300 / 0/300 | 299/300 / 299/300 |
|  | `selectPresentation` | 86µs | 30µs |

`projectTranscript` 本身（O(轮次) 的对象查表）改前改后都在 37–186µs 之间波动，本页不动它。
（minimap 每批少一次 N 个按钮的 React 协调未计入上表。）

**验收**：`bun run typecheck` / `bun run lint` 各自通过；`bun test features/conversation`
**316 pass / 0 fail**（P-02 基线 305，新增 11）；`bun run all` 全绿
（1875 pass / 0 fail，较 P-02 的 1864 新增 11）。

**偏差**：无契约、无依赖、无协议、无持久化数据变化；回滚即整笔 revert。
方案 §6 的 diff 落位与仓库现状一致，唯 `transcript-projector.ts` 里 `EMPTY_SEALED` 的注释
按新位置（`ProjectionMemo` 工厂上方）写；`#memoOf` 的插入位置紧跟 `#publish` 之后。

**待真机复核**（方案 §8，需 Windows 桌面实例）：一条 ≥100 轮、会派子代理的对话，
React DevTools Profiler 录 5 秒流式 —— `TickList` 只在新增一轮 / 某轮封口时出现在提交里
（改前每批都有）；Performance 面板里 `prefixOf` 自身耗时接近 0；发消息后提交气泡被真实轮次
替换时只有一个气泡；待办面板、任务面板「智能体」一节显示与改前一致；minimap 悬停已完成的
轮次显示完整回复。

## P-05 工具输出与文本流的通道压缩：批内合并、运行中节流、环形缓存字符预算（2026-10-11）

**来源**：`Project Refactoring Plan/P-05.md`（外部输入，不入库）。

**现状复核**（方案 §2 的证据链逐条对过，行号已漂移、结论不变）：

1. omp 每收到一块输出就把 `tool_execution_update` 连同「到目前为止的尾部输出（≤50KB）」
   整份报一次（`pi-tui` 的 `streamTailUpdates`）；`projector.toolUpdate` 每块输出吐一条带
   完整 `output` 的 `frame.upsert`（`state:'running'`），文本流每个 delta 一条 `append`，
   子代理每帧进度一条带整份 `outputTail` 的 `task.upsert`。
2. Core 通道 `push()` 只是缓冲，`flush()` 把 pending 原样作为一批发出并入环 —— 16ms 内同一
   格的多份整格替换全部发出，同一帧的多个 `append` 不拼接；`RING_CAPACITY = 2000` 只按
   **批数**限，每批可带多份 50KB 输出。
3. 下游每一跳都按「份」付费：Core `JSON.stringify` → Host 主进程 `JSON.parse` →
   MessagePort 结构化克隆（每窗口一次）→ 渲染进程逐条 `applyFrameUpsert` / `applyAppend`。

**改法**（严格按方案 §5 / §6，与旧版方案的差别见其 §4 复核表）：

1. **新增 `features/conversation/src/core/timeline-compact.ts`**：纯函数 `compactOps` 只做两种
   可证明等价的合并 —— 规则 A 把紧邻、同目标、offset 首尾相接的 `append` 拼成一条；规则 B
   把同键整格替换（`frame.upsert` 按 turn/step/frame、`task.upsert` 按 taskId）的新内容放进
   旧槽位（帧 / 任务顺序由第一次插入决定），往回最多看 `COMPACT_LOOKBACK = 64` 条，遇到
   `reset` / `items.remove` 或写同一格的 `append` 停手。`commutes` 用穷尽 switch +
   `assertNever`，上游新增 op 类型时编译不过。未合并时返回原数组（引用相同）。另含
   `frameKey` / `replaceKey` / `estimateChars`（字符串直接取长度，其余才序列化）。
2. **改 `timeline-channel.ts`**：`push()` 逐条走 `accept()`。运行中工具帧的**中间结果**
   （已发出过首帧的 `frame.upsert`、`kind:'tool'`、`state:'running'`）压进 `held`
   （每格只留最新一份），`TOOL_UPDATE_INTERVAL_MS = 100` 到点 `releaseHeld()` + `emit()`；
   首帧与终态立即放行，终态作废压着的那份，`reset` / `items.remove` 前先放出；公开
   `flush()`（position / catchUp / dropHistory / 订阅快照用）先放压着的再发；`reset()` /
   `dispose()` 共用 `discard()` 清两个定时器、`held`、`running`、环与 `ringChars`。
   `emit()` 发出前 `compactOps`，入环时按批数与 `RING_MAX_CHARS = 8_000_000`（约 16MB
   UTF-16）双限裁旧（至少留最新一批），`catchUp` 去掉内部 `chars` 字段、对外形状不变。
3. **协议形状不变**：op 的类型与字段都没动，只是少发、合并发；不改 engine-omp、不改 UI。

**行为变化**（方案 §5.4）：工具卡片照样立刻出现（首帧不节流）；运行中输出最多 10 次/秒、
总是最新一份；完成 / 失败立即且不会被晚到的中间结果盖回「运行中」；文本流与子代理进度在
16ms 批内合并（视觉无差别）；断线重连补发变成「最近 2000 批且 ≤ 800 万字符」，超了走原有
整读路径。

**测试**（先写、在旧代码上确认红，再实现）：

- `timeline-compact.test.ts`（新，13 例）：C1–C11 手写规则（拼接、屏障、槽位、回看上限、
  不修改输入、计费规则）；C12 / C13 随机序列对拍（500 × 60 / 300 × 40 条），判据是真实
  `applyOps` 折叠结果 `toEqual`。旧代码上模块不存在，直接红。
- `timeline-channel-gate.test.ts`（新，8 例）：K1 批内 30 token → 1 条 append（旧 30 条）；
  K3 1 秒 200 份 50KB → ≤ 12 份且最后一份最新（旧 201 份）；K4 终态作废压着的中间结果
  （旧多发一份 partial）；K7 300 批 × 100K 字符后从头补发判为不完整（旧按批数不裁）；
  K2 / K5 / K6 / K8 是护栏（旧代码上也过）。实测旧代码 **4 pass / 4 fail**，红的是
  K1 / K3 / K4 / K7，与方案完全一致。
- 变异检验（量完即改回，`git hash-object` 确认与方案代码一致）：`items.remove` 改为可交换
  ⇒ C5、C13 失败；`append` 改为总可交换 ⇒ C6、C8、C12 失败。
- `timeline-channel.test.ts`（既有 215 行）与其它既有用例一行未改，原样通过。

**微基准**（方案 §8 脚本，同一台机器，量完删除、未提交）：

| 场景 | 旧代码 | 新代码 | 变化 |
| --- | --- | --- | --- |
| bash 每 5ms 一块、尾部 50KB、持续 10 秒后完成 | 501 批，JSON 共 **102.7MB**，pushCost 82.9ms | 101 批，JSON 共 **5.1MB**，pushCost 34.7ms | 发送量 ÷20 |
| 文本流每 2ms 一个 token、持续 10 秒 | 625 批，**5000** 条 op | 625 批，**625** 条 op | op 条数 ÷8 |

**验收**：`bun run typecheck` / `bun run lint` 各自通过；`bun test features/conversation
packages/transcript` **356 pass / 0 fail**；`bun run all` 全绿（1896 pass / 0 fail，
较 P-04 的 1875 新增 21 = C1–C13 + K1–K8）。

**偏差**：无契约、无依赖、无协议、无持久化数据变化；回滚即整笔 revert。
四个落位文件与方案 §6 的代码块逐字一致（逐文件字符串比对 True），旧 `timeline-channel.test.ts`
未动。

**待真机复核**（方案 §8，需 Windows 桌面实例）：让 agent 跑大输出命令（如 `git log --stat
-n 3000`）—— 工具卡片立刻出现、滚动无肉眼可见卡顿、完成不闪回「运行中」；运行中最小化
5 秒再还原应即时；DevTools Performance 录 5 秒对比 `MessagePort` 处理与 apply 时长下降、
Core 内存在长命令期间不再持续上涨；运行中断开重连（或刷新窗口）时间线完整无重复无缺口。

## P-06 首屏入口闭包：公式 / 终端 / 灯箱按需加载 + 安装版走 poietica-app://（2026-10-11）

**来源**：`Project Refactoring Plan/P-06.md`（外部输入，不入库）。分两笔提交：**A** 按需加载
与构建期守卫（14 个文件）；**B** 安装版改经 `poietica-app://` 加载以启用 V8 代码缓存（5 个文件）。

**现状复核**（与方案 §2 逐条对过）：

1. `prose.tsx:4-5` 静态导入 `@streamdown/math` 与 `katex/dist/katex.min.css`，模块顶层
   `createMathPlugin` —— katex 整块（497KB）在入口闭包里。
2. `terminal/src/ui/index.tsx` 静态导入 `TerminalPanel` / `createTerminalRuntime` 与 xterm.css；
   `terminal-sessions.ts` 再静态导入 `@xterm/xterm` 与两个插件（412KB 在入口分块里）。
3. `image-lightbox.tsx` 静态导入灯箱库、插件与 CSS，被三处调用方（`attachment-tray.tsx:6`、
   `message-attachments.tsx:5`、`tool-call-panels.tsx:6`）静态引用。
4. `windows.ts:70/116` 用 `loadFile` 从 `file://` 加载；Chromium 默认只给 http(s) 开 V8 代码缓存。

**改法**（严格按方案 §5 / §6；与旧版方案的差别见其 §4 复核表）：

1. **A-1 公式按需 `math-plugin.ts`**：模块级单例 `loadMath()` 用
   `Promise.all([import('@streamdown/math'), import('katex/dist/katex.min.css')])` 加载并缓存；
   失败清 pending 供重试；`currentMath` / `subscribeMath` 给 `useSyncExternalStore`；`prose.tsx`
   换成稳定引用的 `BASE_PLUGINS` / `pluginsWithMath`（Streamdown 按引用做 memo），发现 `$`
   时在 effect 里触发加载；会话功能第一次 `onCoreReady` 预取。
2. **A-2 终端按需 `terminal-loader.ts`**：`createLazyTerminalRuntime` 返回与原运行时同名方法的
   代理（`count` 未加载为 0，通知类方法未加载是空操作）；`restore()` 先 `list()`，Host 里没有
   终端就不加载；面板改成 `lazy(() => Promise.all([runtime.load(), import('./terminal-panel')]))`；
   xterm.css 移进 `terminal-sessions.ts`，terminal-pane.css 移进 `terminal-panel.tsx`。
3. **A-3 灯箱按需**：`image-lightbox.tsx` 拆成轻壳 + `image-lightbox-impl.tsx`，类型单独成
   `image-lightbox-types.ts`（避免壳与实现成环）；壳只在 `open` 时挂载实现，有缩略图时
   `requestIdleCallback` 预取；`plugins={[Zoom, Counter]}` 提成模块常量。
4. **A-4 构建守卫**：`electron.vite.config.ts` 的 `poietica:entry-budget` 插件沿入口静态
   `import` 走闭包，命中 katex / @xterm / yet-another-react-lightbox 即 `this.error`；闭包超
   5.4MB 只 `this.warn`。
5. **B 自定义协议**：新 `packages/host-kernel/src/app-protocol.ts` 的
   `createAppProtocolHandler(rendererDir, fetchFile)`（只接受 GET + host `shell`、逐段
   `decodeURIComponent`、拒绝 `.` / `..` / 斜杠 / 反斜杠 / NUL / 坏编码，再用 `path.relative`
   兜一层）；`kernel.ts` 注册 `poietica-app` 特权（`standard/secure/supportFetchAPI/corsEnabled/codeCache`）
   并在 ready 后 `protocol.handle`（安装版 `net.fetch(pathToFileURL(file))`，能读 asar）；
   `windows.ts` 的 `createMain` 删掉 `rendererFile`，统一 `loadURL(appUrl)`，导航守卫与加载
   用同一个 `appUrl`。

**测试**（先写、在旧代码上确认红，再实现）：

- 新用例 21 条：`prose-math.test.tsx` M1–M3、`image-lightbox.test.tsx` B1–B3、
  `terminal-loader.test.ts` L1–L8、`app-protocol.test.ts` A1–A7。旧代码上
  `prose-math` / `terminal-loader` / `app-protocol` 三个文件因模块不存在而直接失败
  （实跑 `3 pass / 3 fail / 3 errors`），`image-lightbox` 三条是行为护栏（旧代码上也过）。
- 构建守卫反向验证：临时把 `prose.tsx` 换回静态 `createMathPlugin` + katex.css，构建以
  `[plugin poietica:entry-budget] 这些按需加载的包被静态带进了首屏入口` 失败（报出
  `/node_modules/katex/ ← …`）；改回后构建通过。
- 既有终端 33 个用例一行未改原样通过（`bun test features/terminal` 74 pass）。

**体积**（`electron-vite build --mode production` + 等价 closure 脚本实测）：

| 指标 | 改前 | 改后 |
| --- | --- | --- |
| 首屏入口静态闭包 JS | 6.18MB / 10 files | **5.11MB / 17 files** |
| 首屏 CSS | 497.7KB | **451.9KB** |
| xterm / katex / 灯箱 | 入口分块内 | 独立分块（`terminal-store-*.js` 431KB、`katex-*.js` 497KB、灯箱分块） |

**偏差**：

1. **公式测试需要复位口**（方案未写）：`bun test` 单进程跑完全仓，多个测试文件共享同一份
   模块实例；`apps/desktop/src/renderer/__tests__/core-recovery.test.tsx` 会真的启动一次功能、
   触发首次 `onCoreReady` 预取，M1「没有 `$` 就不加载」于是看见脏状态。加
   `resetMathForTests()`（代号作废在途加载，不让晚到的结果或失败写回新一代状态），
   测试在 `beforeAll` 调用 —— 与既有 `resetDiagramCacheForTests` 同一手法。
2. **闭包实测 17 files / 5.11MB**：方案 §6 第 6 步写「约 17 files 5.11MB」，与实测一致；
   方案 §5.4 表格里的「闭包小 17%」按 6.18 → 5.11 计算为 −17.3%，一致。
3. 其余落位文件与方案 §6 的代码块逐字一致；`terminal-store.ts` / `terminal-sessions.ts` 的
   会话层逻辑一行未改（CSS 导入按方案搬家）。

**验收**：`bun run typecheck` 通过（711 files / 80 projects + 909 tests files）；
`bun run lint` 通过（biome + no-raw-errors + no-biome-ignore + editor-project-map + depcruise）；
`bun test features/conversation features/terminal/src/ui packages/transcript packages/host-kernel`
**456 pass / 0 fail**；`bun run all` 全绿（1917 pass / 0 fail，较 P-05 的 1896 新增 21）。

**待真机复核**（方案 §8 第 8 步，需 Windows 安装版实例）：`location.origin` 为
`poietica-app://shell`、无 CSP 报错；公式（KaTeX 字体）、diff 着色（shiki WASM）、审查面板
worker、`poietica-asset://` 图片、widget iframe、拖文件、外链、渲染进程崩溃 reload 各一条；
第 3 次启动后 `%APPDATA%\Poietica\Code Cache\js` 有数 MB 文件；打包后 asar 内文件经
`net.fetch(file://)` 能读到。

## P-03 流式正文的「批次波浪淡入」：逐字 span 动画换成 Web Animations 钉时刻（2026-10-11）

**来源**：`Project Refactoring Plan/P-03.md`（外部输入，不入库）。P-02 / P-04 / P-05 / P-06
均已在本页之前合入，故按方案 §5 第 7 步末尾「已合入 P-06 时」的合并版本落位。

**现状复核**（方案 §2 的证据链逐条对过，行号已漂移、结论不变）：

1. `prose.tsx` 用 `REVEAL = { sep:'char', duration:120, stagger:12, maxBacklogMs:160 }` 交给
   Streamdown 的 `animated`；`timeline.css` 的 reduced-motion 规则只针对 `[data-sd-animate]`。
2. streamdown 2.7.0 的动画插件给**每个字**包一个 `[data-sd-animate]` span，且上一次渲染已
   出现的字被改成 `--sd-duration: 0ms`、无 delay —— 动画生命周期 ≤ 一次提交间隔，连续流式中
   就是在开始前被截断成「直接显示」（实验 1：任意时刻只有最新约 6 个 span 在播，其余全跳变）。
3. 外层 `Streamdown` memo 不比较 `rehypePlugins`，只换插件链不会重渲，必须同时改 className；
   块组件 memo 比较 `rehypePlugins` 身份，链必须只建一次。
4. 处理器缓存按「插件函数名 + 选项 JSON」做键，自定义插件必须有唯一函数名。
5. 数学插件的 rehype 排在用户 `rehypePlugins` **之后**，KaTeX 会把 `code.math-inline` 整个
   换掉 —— 标记必须打在外层 span 上才留得住。

**改法**（严格按方案 §4 / §5 / §6，与旧版方案的差别见其 §4 复核表）：

1. **`wave-reveal.ts`（新，纯函数 rehype 插件）**：每次块渲染与最近 8 个块的账本比对出
   「新到的字」，按字素切成小段（每段 ≥ 6 字素、一批 ≤ 24 段），相邻小段错开
   `min(stepMs=30, spreadMs/(段数−1))` 启动；下一批接在上一波尾巴后（全局游标）但积压 ≤ 240ms。
   只把**仍在淡入中**的小段包成 `<span data-wave-start="绝对启动时刻">`，淡完的并回普通文本。
   超大批只动画末尾 `hugeTail=600`；`pre/svg/math/annotation` 不拆；`img/hr` 整体算一个字；
   行内 `code` 外包一层 span。末尾改写（未闭合的强调 / 链接补全）按「公共前缀 ≥ 8 且只改末尾
   ≤ 16 字」认作同一块。插件名唯一（`rehypeWaveReveal$序号`）；`now` 可注入，单测用假时钟。
2. **`wave-dom.ts`（新，`syncWave(host)`）**：`useLayoutEffect` 里扫正文子树的
   `[data-wave-start] / [data-wave-marker]`，用 `el.animate()` 挂淡入，并把 `animation.startTime`
   **钉在标记的绝对时刻**（`performance.now()` 与 `document.timeline` 同源）。同一元素同一时刻
   不重复挂；React 复用节点导致时刻变化时改钉同一条 → 不重播、不截断。`fill:'backwards'`：
   启动前透明、播完不留样式；一次提交新起动画超过 `maxFreshPerCommit=64` 时，靠前的直接实显。
3. **`use-wave-reveal.ts`（新，Hook）**：`streaming` 期间挂插件链，结束后再「逗留」到
   `busyUntil()` 才摘（否则最后一波会被截断）；`useSyncExternalStore` 订阅
   `prefers-reduced-motion`，开启时或没有 `Element.prototype.animate` 时根本不挂插件。
   链只建一次（身份稳定）；首个挂链的提交只记账，`arm()` 之后才排程。
4. **`prose.tsx`**：删掉 `animated={REVEAL}`、`REVEAL` 常量和 `AnimateOptions` 导入；改用
   `useWaveReveal(...)` 的链，外包一层 `display: contents` 的 `.timeline-prose-host` 作为扫描
   范围，插件链切换时同时切 `timeline-prose--wave` 修饰类。**P-06 的按需公式插件保留**：
   `const plugins = useProsePlugins(text)` + `plugins={plugins}` 一字未动。
5. **`timeline.css`**：删掉只认 `[data-sd-animate]` 的 reduced-motion 规则（现在由 Hook 决定
   挂不挂），换成 `.timeline-prose-host { display: contents }`。

**测试**（先写、在旧代码上确认红，再实现）：

- `__tests__/prose-wave.test.tsx`（新，4 例）：P1 流式中不产生逐字 span 且在飞波浪 span ≤ 40、
  P2 结束后 DOM 无残留标记、P3 非流式从不挂插件、P4 首帧已有的字不做动画。旧代码上
  **P1 失败（`Expected length: 0, Received length: 3`，逐字 span）**，P2–P4 也过（防回归）。
- `__tests__/wave-reveal.test.ts`（新，15 例）：W1–W15 覆盖未 arm 只记账、不重播、分段与
  错开启动、跨批首尾相接与积压上限、淡完并回、3000 字在飞 span ≤ 16、字素边界、
  末尾改写、结构（pre / 行内 code / li marker / img）、超大批、插件名唯一、busyUntil。
- `__tests__/wave-dom.test.ts`（新，3 例）：D1 startTime 钉在标记时刻、D2 重复 sync 不新建
  动画且改时刻只重钉同一条、D3 一次提交超上限时靠前的直接实显。

**验收**：`bun run typecheck` 通过（714 files / 80 projects + 915 test files）；
`bun run lint` 通过（biome + no-raw-errors + no-biome-ignore + editor-project-map + depcruise）；
`bun test features/conversation` **365 pass / 0 fail**（基线 343，新增 22 = 4 + 15 + 3）；
`bun run all` 全绿（1939 pass / 0 fail，较 P-06 的 1917 新增 22）；
`cd apps/desktop && bun x electron-vite build --mode production` 通过（P-06 的入口守卫未触发）。

**偏差**：无契约、无协议、无持久化数据变化，业务代码未动引擎与数据；回滚即整笔 revert。
落位文件与方案 §5 / §7 的代码块逐字一致（唯按 P-06 已合入后的合并版本写 `prose.tsx`）。
新增依赖：`@types/hast@^3.0.4`（写进根 `catalog` 与 `features/conversation` 的
`devDependencies`），已跑 `bun install`。

**待真机复核**（方案 §7，需 Windows 桌面实例）：2000 字以上含列表 / 行内代码 / 行内公式 /
代码块的长回复，末尾应有「前实后淡」的渐变带、无逐字跳、停顿后突发是「一道波扫过去」；
DevTools 里流式中 `data-sd-animate` 为 0、`data-wave-start` 只有几十个且随输出替换；
Performance 录 10 秒对比提交耗时；结束后约 0.7 秒标记归零且复制内容与旧版一致；
流式中最小化 10 秒再切回只淡末尾一截；系统「减少动态」开关运行时切换立即生效；
切会话 / 滚出视口再回来已显示的字不重播；历史消息、计划面板、技能文档、工具结果面板外观不变。

## P-07 浏览器面板的浮层观察：只看应用根之外的传送门（2026-10-11）

**来源**：`Project Refactoring Plan/P-07.md`（外部输入，不入库）。P-02～P-06 均已合入，
本页与它们不同文件、无冲突；按方案 §5 的分步执行。

**现状复核**（方案 §2 的证据链逐条对过，行号漂移 1 行、结论不变）：

1. `index.tsx` 的 `dialogOpen()` = `document.querySelector('[role="dialog"][data-open]')`，整份文档查询。
2. `BrowserPanelHost` 的 effect 用 `MutationObserver` 观察 `document.body`（`subtree + attributes`），
   `update` = `setCovered(overlayOpen(dialogs))`；右坞收起不卸载（`regions.tsx` 只加 `inert`），
   `auxiliary-dock.tsx` 的 `fallbackGroup` 让有标签页的浏览器面板常驻 —— 对话每提交一帧 DOM
   变动都叫醒它一次。
3. 全仓 `role="dialog"` 只有两处自建：本页这处查询，与 `context-gauge.tsx`（不带 `data-open`）。
   design-system 的浮层都建在 Base UI 上，FloatingPortal 不传 `container` 时传送门 div 挂在
   `document.body` 的直接子节点；应用根是 `<div id="root">`。

**改法**（严格按方案 §4 的 `overlay-watch.ts` 逐字落位）：

1. **`features/browser/src/ui/overlay-watch.ts`（新）**：两个纯 DOM 函数。
   `overlayPresent(doc, appRootId='root')` 只遍历 `body` 的直接子节点、跳过应用根，在每个
   传送门子树里查 `[role="dialog"][data-open]`；`watchOverlays(doc, onChange, appRootId='root')`
   同一个 observer 观察两处 —— `body` 只看 `childList`（传送门来去），每个非应用根的直接子节点
   看 `subtree + childList + attributes(data-open)`（新加入的子节点在回调里补挂，`WeakSet` 防重复）。
   观察者注册在闭包里的 `observer` 引用其后声明，合法（`watch` 只在 observer 创建后才调用）。
2. **兜底**：`appRootOf()` 要求 `#root` 是 `body` 的直接子节点；找不到时 `overlayPresent` 退回整份
   文档查询、`watchOverlays` 退回整树观察，行为与旧逻辑一致。
3. **`index.tsx` 只改两处**：`dialogOpen()` 调 `overlayPresent(document)`；effect 里
   `watchOverlays(document, update)` 替掉手写的 observer，清理换成 `stopOverlays()`。

**不做**（方案 §4 明确）：不建 design-system 的浮层注册表；不动右坞「收起仍挂载」的设计。

**测试**（先写、在旧逻辑上确认红，再实现）：新文件 `overlay-watch.test.ts` 8 条，
旧逻辑上 **O1、O5 失败（6 pass / 2 fail）**，与方案 §5 第 2 步的实测一致；换成新实现后
`bun test features/browser/src/ui/__tests__/overlay-watch.test.ts` **8 pass / 0 fail**。

| 编号 | 断言 | 防的是什么 |
| --- | --- | --- |
| O1 | #root 里增 200 个带 data-open 的元素、再去掉一个 data-open → 回调 0 次 | 流式输出叫醒浏览器面板（旧逻辑失败） |
| O2 | 传送门出现 → 回调且判为有浮层；移除 → 回调且判为无 | 命令面板 / 对话框开关漏判 |
| O3 | 已有传送门里 data-open 开合各回调一次 | keepMounted 浮层开合漏判 |
| O4 | 新传送门先挂空壳、弹层晚一步挂上 → 仍能看到 | Base UI 先建传送门、后渲染弹层的时序 |
| O5 | #root 里的 role=dialog 不算浮层 | 查询范围收窄（旧逻辑失败） |
| O6 | 不带 data-open 的自建 role=dialog（上下文仪表）不算 | 与旧行为一致 |
| O7 | 停止后不再回调 | 卸载泄漏 |
| O8 | 找不到 #root 时退回整树观察 | 挂载点改名时不静默失效 |

**验收**：`bun run typecheck` 通过（715 files / 80 projects + 917 test files）；
`bun run lint` 通过（biome + no-raw-errors + no-biome-ignore + editor-project-map + depcruise）；
`bun test features/browser` **112 pass / 0 fail**（基线 104，新增 8）；
`bun run all` 全绿（1947 pass / 0 fail，较 P-03 的 1939 新增 8）。

**偏差**：无契约、无协议、无持久化数据变化；落位文件与方案 §5 的代码块逐字一致。
方案 §8 的风险表照录：将来有人把浮层渲染进 #root（传 `container`）时不会再让浏览器收起
（契约写在 `overlay-watch.ts` 头注）；渲染进程挂载点改名走 O8 兜底；第三方往 body 挂节点
只会多报不会漏报。回滚即整笔 revert。

**待真机复核**（方案 §7，需 Windows 桌面实例，与 P-02～P-06 同例）：右坞打开浏览器并加载
页面后 —— 打开命令面板 / 确认框 / design-system Dialog，原生视图立即收起、关闭立即恢复；
嵌套浮层逐层关闭的时机与旧版一致；收起右坞让对话流式输出，DevTools Performance 里不再出现
来自 `browser/src/ui/index.tsx` 的 MutationObserver 回调；浏览器面板的拾取、地址栏聚焦
（Ctrl+Shift+L）行为不变。


## P-08 自动总结对话标题：打开 omp 的能力并接到线程行上（2026-10-11）

**来源**：产品负责人交办（「omp 不是有自动总结成对话标题的能力吗，开启，并且接线」）。要求：
新对话标题**先**用现有的首句兜底（`deriveTitle`），omp 总结成功后**替换**，失败则保留兜底。

**根因**：omp 18.5.0 确实自带这个能力（`AgentSession.maybeStartTitleGeneration` →
`utils/title-generator.ts` 的 `generateSessionTitle`），但本仓库在两处主动关掉了它
（`bootstrap/isolation-env.ts` 的 `PI_NO_TITLE: '1'` 与 `runtime-layout/src/core-launch.ts` 的同一个键，
omp 的 `maybeStartTitleGeneration` 见到它就 return）。而且即使打开，omp 只把标题写进**会话文件的
固定 256 字节标题槽**，与 Core 的 `conversation_threads.title` 是两份事实 —— 所以「开启」必须
配套「接线」。

**改法**（方案 A：产品语义干净；先经子代理审查过，四条硬伤已采纳）：

1. **删开关**：`ISOLATION_ENV_KEYS` 与 `isolationEnv()` 的 `PI_NO_TITLE`、
   `buildCoreLaunch` 的同名键、测试夹具 `omp-home.ts` 的两处、`core-launch.test.ts` 的断言。
2. **端口**（`packages/engine/src/session.ts`）：`EngineSessionEvent` 新增
   `{ type: 'sessionTitle'; title: string; sessionFile: string }`；`OpenSessionSpec` 新增可选
   `autoTitle?: boolean`（缺席 = 允许）。
3. **engine-omp**：
   - `session.ts` 加公共出口 `emitSessionTitle(title)`（`emit` 是 private），并在**无订阅者**时先存着
     —— `onSessionNameChanged` **没有回放**，而会话池要等 `openSession` 返回才订阅；
   - 首条真轮代 omp 触发一次：它的触发点在 omp 的 input-controller 里，而 Poietica 直接调
     `session.prompt`，那条路永远不会发生（实测：不显式调用就永远没有标题）；
   - 适配器订阅 `sessionManager.onSessionNameChanged`（**回调不带名字**，要自己读
     `getSessionName`），退订进 `subscriptions`；打开已有名字的会话时补报一次；
   - 引导侧两条配套（`create-engine.ts`）：`title.refreshOnReplan=false`（否则 todo 重规划会
     **二次换名**）、`retry.modelFallback=false`；
   - **标题模型门禁**：`title-generator` 在候选表为空时会**把当前会话模型追加进候选**
     （`utils/title-generator.ts:134`，与 `retry.modelFallback` 无关），那是一次真实计费请求。
     新增 `hasTitleRoleModel()`：tiny → commit → smol 里解析不出模型就**不触发**，标题留在兜底上。
     测试入口用 `disableAutoTitle` 关掉（mock 也是 tiny 候选，否则标题请求会吃掉一条脚本回复）。
4. **conversation**：`thread-service.ts` 新增 `setTitleFromSession(threadId, title, sessionFile)`
   （守卫：行没了 / `user` 定过名 / `sessionFile` 对不上 / 空或同值，四条都不改）；
   `describe()` 里 `autoTitle: row.titleSource !== 'user'`；`event-router.ts` 加
   `case 'sessionTitle'`，`conversation.ts` 装配。
5. **engine-testkit**：FakeEngine 按同一语义发事件（只首条真轮、`autoTitle === false` 不触发、
   「生成失败」= 什么都不发），供一致性用例与 conversation 用例驱动。

**契约**：`titleSource` 仍是 `pending|auto|user`，**RPC 形状不变**，故 `PROTOCOL_VERSION` 不动、
`protocol:snapshot` 跑完无 diff（已实测）。

**测试**：`packages/engine-omp/src/__tests__/auto-title.test.ts`（4 条：事件带 sessionFile、
首条真轮触发一次、订阅晚于打开时的补发、`autoTitle=false` 不触发）；
`features/conversation/src/core/__tests__/auto-title.test.ts`（5 条：兜底→替换、失败留兜底、
user 不被覆盖、已定名线程不触发、迟到事件 / 用户改名两条守卫）。

**验收**：`bun run all` 全绿（1956 pass / 0 fail，较 P-07 的 1947 新增 9）；
`bun run protocol:snapshot` 无 diff；`bun run core:probe` 全过（隔离自检仍成立、
假用户目录零泄漏 —— 删掉 `PI_NO_TITLE` 不影响隔离）。

**偏差 / 待决**：
1. 标题的**成本**与产品默认值：门外汉用户没配 tiny/commit/smol 角色时，本实现**不生成**标题
   （保留首句兜底），而不是拿主模型烧一次额度。若产品要「没配 tiny 也用主模型」，把
   `hasTitleRoleModel` 的门禁去掉即可 —— 这是一条产品取舍，已按「后台小事不烧正文模型」定。
2. omp 的标题写进**会话文件**（它自己的槽），Core 的行是另一份；两边由 `sessionTitle` 事件对齐。
   用户在 Poietica 里改名**不会**回写 omp 的会话文件 —— 下次重开该会话时，omp 侧的名字仍是旧的，
   但 Core 的 `user` 守卫会挡住它（不会覆盖用户的定名）。要彻底一致需在开会话时反向
   `setSessionName(row.title,'user')`，代价是每次开会话多写一次会话文件，**未做**，记此待决。
3. 真机复核：配好 tiny 角色的机器上，新对话首条消息后应看到标题由首句变成总结标题；
   未配 tiny 的机器上标题保持首句。**待真机确认**。


## R-19 手动添加的模型服务商不生效：入口页仍报「还没有配置任何模型服务商」，模型页要等重启才出现（2026-10-12）

**来源**：产品负责人报告（「明明我已经配置了模型，却还是显示『还没有配置任何模型服务商』，
是不是因为我是手动添加的，而不是使用内置服务商的原因？」），要求用**更彻底的做法**修。
排查中发现这条路上并排着两个缺陷，第二个才是「手动添加不生效」的真正原因。

**根因**（两条，都在 `packages/engine-omp`）：

1. **`configured` 判据与 omp 自己的鉴权判据不同源**（`ports/models.ts` 的 `providers()`）。
   端口原来只查 `credentials.has(id)`（agent.db 里的凭据行），而 omp 的
   `ModelRegistry.hasConfiguredAuth` 认**四类**来源（model-registry.ts:2749-2757）：
   models.yml 里写死的 `apiKey`（`#customProviderApiKeys`，411 行 `#installProviderApiKey` 写入）、
   声明 `auth: none` 的免密钥 provider（`#keylessProviders`，1660-1663 行）、
   凭据表（`authStorage.keys.source`）、环境变量别名。手动添加的服务商钥匙写在 yml 里，
   凭据表里没有它 —— 于是模型选择器（走 `getAvailable`）一条不少地列着它，
   而入口页的横幅（走 `providers.configured`）挂着「还没有配置」。
   真机数据印证：`%APPDATA%\Poietica\omp\agent\models.yml` 里 `magpie-workbuddy` 带内联 apiKey、
   `magpie` 是 `auth: none`，而 `agent.db` 里只剩一条被删掉的 deepseek 凭据。

2. **写完 models.yml 之后的「重读」是空操作**（`ports/omp-ports.ts` 的 `reload` 回调）。
   回调写的是 `registry.reload?.()`，而 omp 18.5.0 的 `ModelRegistry` **没有 `reload()`**
   （官方成员表见 `docs/omp-sdk-reference.md` A.3）—— 可选链每次都静默落到 `undefined`，
   函数返回、文件写盘、内存目录一动不动。后果：用户加完服务商，模型页与设置页全都不出现它，
   **重启才生效**；而「自定义服务商」的判据 `customProviders.defined(id)` 直读文件，
   所以 `providers()` 里连这一家都不在 —— 与报告的症状完全一致。

**改法**：

1. `ports/models.ts`：`providers()` 把全部模型按 provider 归并（`all()` 与 `available()` 两份都收，
   后者补前者没有的），逐家拿一条模型问 `registry.hasConfiguredAuth(model)` 当 `configured`。
   判据从此与 omp 自己「这家能不能用」同源，四类来源一并认。
2. `ports/omp-ports.ts`：`reload` 改调 `registry.refreshIfStale()`（官方 API：按 models.yml 的
   mtime 决定要不要重读，目录没变就不动）；`omp-context.ts` 的 `OmpModelRegistry` 补上这一格，
   把「没有 `reload()`」写成 omp 知识 #18。
3. 文档/注释同步：`packages/engine/src/ports.ts` 与 `features/models/src/contract/index.ts`、
   `title-model-group.tsx` 里「providers.configured 只认凭据表」那三处免责说明按新语义改写
   （旧文字描述的是一个已经不存在的缺陷，留着会误导）。

**测试**（规矩：先写一条在旧代码上失败的用例）：

- `packages/engine-omp/src/ports/__tests__/models.test.ts`：把夹具的 `hasConfiguredAuth` 从恒真
  改成按 provider 记账，新增「providers 的 configured 跟 omp 的鉴权判据，不由凭据表说了算」——
  旧实现下这条红（表里没有 openai 的凭据，但 omp 判它已配）。
- `packages/engine-omp/src/ports/__tests__/omp-ports.test.ts`（新文件）：组合根的 `reload` 回调必须
  调**真实存在**的方法 —— 旧实现下两条都红（`upsertCustomProvider` 与 `setApiKey` 之后谁都没被调）。
- `packages/engine-testkit/src/conformance.ts`：新增 `C-CUSTOM-PROVIDER-CONFIGURED`，两个引擎同时跑
  （手动加的服务商当场带 `custom` + `configured` 出现，删掉之后就没了），防替身与真实现再次分叉。

**验收**：`bun run all` 全绿（**1963 pass / 0 fail**，改动前实测基线 1958，新增 5 条用例 ——
models 端口 1 条、omp-ports 2 条、一致性套件 C-CUSTOM-PROVIDER-CONFIGURED 两个引擎各 1 条）；
`bun run protocol:snapshot` 无 diff（`ProviderInfo` 形状未动，
`PROTOCOL_VERSION` 保持 15）；改动未碰隔离、未碰 omp 的启动环境，故未跑 `core:probe`。
真机（本机 `%APPDATA%\Poietica` 与 `Poietica Dev` 两份数据）复核：手动加的服务商在
`providers()` 里现在是 `configured: true`，横幅不再出现；`upsertCustomProvider` 之后当场
出现在 `models()` 与 `availableModels()` 里，不需要重启。

**偏差 / 待决**：

1. **顺带修了第 2 条**（reload 空操作），它不是报告点名的症状但同属「手动添加的服务商不生效」
   这一条用户可感知的链路：只修判据的话，用户在设置页里加完服务商仍然看不到它，报告的问题只解决一半。
   两条改动落在同一路径（模型的读与写），一并提交。
2. `catalog-port.ts` 里 `provider.custom || provider.configured` 的兜底**保留未动**：修完判据之后它
   已经多余，但它是界面侧的既有写法、行为等价，按「改动只覆盖任务点名的范围」不顺手重构。
   留给下次碰这一页时删。
3. `packages/engine-omp/src/ports` 目录里 `mcp` / `skills` / `draft-controls` 有几条**既存**失败
   （与本次改动无关：改动前 `bun test packages/engine-omp/src/ports` 同样红；整目录单跑会
   互相干扰，单文件跑全过 —— 属 omp-home 夹具的进程级共享状态）。**待决**：给这几条找一条
   能整目录跑的隔离办法。

## B-01/B-17/B-10/B-02/B-03/B-04/B-09/B-15 阶段 0：浏览器工具卡片与标签面（2026-10-12）

**来源**：产品负责人交办的阶段 0 规格 `阶段 0.md`（八项，逐项单独提交，任何一项出问题
`git revert` 该提交不影响其它项）。八项全在 `features/browser` 与
`features/conversation` 的工具视图里，互不共享代码路径。

**逐项**

| 项 | 提交 | 内容 |
| --- | --- | --- |
| 0.1 B-01 | `fix(browser): 工具卡片改读 omp 18.5 的 eval 产出形状` | 新增纯数据层 `ui/tool-card-model.ts`；卡片重写为「折叠行 + 步骤 / 截图 / 代码 / 输出 / 错误」 |
| 0.2 B-17 | `fix(conversation): 运行中的 eval 按代码预判是不是浏览器` | ops 为空时按代码文本预判，避免开头几百毫秒的跳变 |
| 0.3 B-10 | `feat(browser): 「在面板中查看」切到那条地址所在的标签` | `revealTabFor`：精确匹配（忽略 hash）→ 同源 → 不切 |
| 0.4 B-02 | `fix(browser): 每张标签都摆真实尺寸，后台标签不再按 1×1 排版` | 每张标签都 setBounds；`rectKey` 指纹去重 |
| 0.5 B-03 | `fix(browser): AI 附着期间关掉那张标签的后台节流` | attach 后 `setBackgroundThrottling(false)`，detach 回执恢复 `true` |
| 0.6 B-04 | `fix(browser): 「AI 正在使用」改成真的在驾驶，而不是连上了` | `attached` 集合 + `onAttachedChange`；`onConnectedChange` 留给日志 |
| 0.7 B-09 | `fix(browser): 非用户原因的内核 detach 不再让 relay 拉黑标签` | `USER_DETACH` 正则；理由进 info 日志 |
| 0.8 B-15 | `fix(browser): 溢出菜单不再有死按钮` | `commands` 属性决定行是否可点；本阶段传空对象 |

每项都先写一条在旧代码上失败的测试（`git stash` 过实现再跑一次核对），八项各自
独立提交。**不需要升 `PROTOCOL_VERSION`**：0.6 只改 `driven` 的语义与注释，形状
（boolean）未动；其余各项都不碰契约形状。

**验收**：`bun run all` 全绿（**2024 pass / 0 fail**，改动前基线 1963；本次新增 61 条用例）。
`bun run protocol:snapshot` 无 diff。改动未碰隔离、未碰 omp 启动环境，故未跑 `core:probe`。

**偏差**

1. **0.2 的预判接受一个误判**（规格已写明，此处留档）：判据是「出现调用形状」而不是
   「解析代码」，写在字符串里的 `browser.open(` 会被认成浏览器调用。卡片仍会照常显示
   代码与输出，信息不丢，只是折叠行先说成浏览器动作。测试里把这条写成已知边界。
2. **0.4 顺带修了「面板从没上报过矩形时也摆 1280×800」**：规格只点名 1×1 的初值，
   但面板从未打开过时 `bounds` 就是那个 1×1，两者是同一条缺陷的两个入口。
3. **0.5 的重复 attach 去重**：面板每次操作都会 attach 一遍，规格没写这一条；
   不去重的话每次操作都下发一次 `setBackgroundThrottling(false)`（无害但白付）。
   用 `Set<WebContentsLike>` 记账，与 B-03 的语义同一处。

**需真机确认**（规格点名的两条，测试覆盖不到）

1. **0.5**：面板收起（视图 `setVisible(false)`）时 `Page.captureScreenshot` 能否出图。
   若不能出图或超时 —— 在下面追加一条记录，阶段 2 的「AI 操作时自动展开面板」会兜住
   常见路径；**不要在本阶段自行发明离屏技巧**。
2. **0.7**：在 dev 版里让 agent 附着一张标签，然后在 Host 调试时对它调用 Electron 的
   `webContents.forcefullyCrashRenderer()` 制造一次崩溃，把日志里
   `browser debugger detached` 的 `reason` 原样记到下面；若与 `USER_DETACH` 正则不符，
   按真实字符串收紧正则并补一条测试。

**真机核对记录**（执行人填写）

- 0.5 面板收起时截图：
- 0.7 崩溃时 Chromium 给的 reason：

## R-20 思考行的划动与换句：遮罩坐标错、按行取句、每批 token 一抽（2026-10-12）

**来源**：产品负责人交办的重设计规格 `思考行动画重设计.md`（仓库输入，不入库）。对象是
对话时间线里过程组**组头**那一行 —— AI 思考时「刷刷刷」的那一句话。七个问题（T-01…T-06）
共用一条根因：这一格实现的是「一个会滚的盒子」，而它要的是**一条电子屏**。

**根因（规格 §2）**

| 现象 | 根因 |
| --- | --- |
| 最新的几个字被淡掉（T-01） | `mask-image` 挂在 `inline-size: max-content` 的字层上，遮罩坐标系是**整句**；窗口又滚到句末，右端那 16px 渐隐正好落在最新的字上 |
| 最左的字被硬切成半个（T-02） | 同上：左端渐隐落在早已滚出窗口的句首上，窗口左缘那个满墨字被 `overflow: hidden` 硬裁 |
| 一顿一顿地往左跳（T-03） | 每次 `revision` 变化在 layout effect 里直接写 `scrollLeft`，无过渡 |
| 多数时候看不到换字（T-04） | 句子身份是**行号**，模型整段不换行就永不换格 |
| 快慢模型都按固定节奏排队（T-05） | `ROLL_MS=300` / `HOLD_MS=500` / `MAX_PENDING=2` 与出字速度无关 |
| 思考里漏出 `**`、`#`（T-06） | 逐字照抄，不认 Markdown |

**改法与文件**

> **这一节的模块表与参数表已被 R-21 取代**（v2 拆掉了 `marquee-model` / `use-marquee` /
> `ink-tail`，换成 `ticker-pace` / `ticker-glide` / `ticker-engine`）。留在这里是为了让
> 「v1 到底错在哪」可查；当下的实现与参数一律以 R-21 为准。

| 模块 | 职责 |
| --- | --- |
| `semantics/thought-sentence.ts` | 取句：从文本尾部往回找**当前句**与**上一句**，交出去记号化之后的正文与「起始偏移」当身份（同句继续写 = 原地生长，异句 = 换格） |
| `timeline/marquee-model.ts` | 纯数学：目标位移、出字速度估计（窗口平均）、逐帧推进、硬底线、到位判定 |
| `timeline/roll-scheduler.ts` | 换句时机：至少露面 / 到位后再停 / 最多等多久；等待期间来的新句顶掉排队那句 |
| `timeline/use-marquee.ts` | 唯一碰 rAF 与 ResizeObserver 的地方；逐帧只写 `transform` 与 `data-*`，不进 React |
| `timeline/marquee-track.tsx` | 一句话的窗口 + 轨道，墨迹与划动挂在同一棵子树上 |
| `timeline/ink-tail.ts` | 新字的墨迹：Web Animations，`startTime` 钉在尾巴开始的绝对时刻（重渲染不重播） |
| `timeline/rolling-line.tsx` | 容器：喂句、提升时换 key、按状态定 mode |
| `timeline/rolling-line.css` | 三层几何：外层只裁只定位，窗口按句各一套（遮罩挂这里），轨道保持自然宽度 |
| `tool-group-card.tsx` | 接线：思考走 `readThoughtSentence` + `variant="thought"` |

**参数表**（规格 §3.3，值即实现）

| 名称 | 值 | 所在模块 |
| --- | --- | --- |
| `TAIL_EM` / `--cp-ticker-tail` | 2 | marquee-model / 令牌 |
| `--cp-ticker-fade` | 2em | 令牌（左侧淡出宽） |
| `--cp-ticker-ink` | `var(--cp-ink)` | 令牌（新字刚写下的颜色） |
| `LAG_SET_EM` | 0.5 | marquee-model |
| `RATE_WINDOW_MS` | 600 | marquee-model |
| `CORRECT_MS` | 300 | marquee-model |
| `VELOCITY_SMOOTH_MS` | 120 | marquee-model |
| `MAX_CATCHUP_PX_S` | 900 | marquee-model |
| `SNAP_LAG_RATIO` / `SNAP_KEEP_RATIO` | 0.6 / 0.15 | marquee-model |
| `SETTLE_EPS_PX` / `SETTLE_SPEED_PX_S` | 0.5 / 4 | marquee-model |
| `MAX_DT_MS` | 64 | marquee-model |
| `ROLL_MS` / `FAST_ROLL_MS` | 260 / 140 | roll-scheduler |
| `ROLL_EASE` | (0.4, 0, 0.2, 1) | rolling-line |
| `ROLL_DISTANCE` / `ROLL_BLUR_PX` | 0.6em / 1.5 | rolling-line |
| `MIN_VISIBLE_MS` / `END_HOLD_MS` / `MAX_WAIT_MS` | 450 / 250 / 1200 | roll-scheduler |
| `INK_MS` | 600 | ink-tail |
| `MAX_SENTENCE_CHARS` / `BACKSCAN_LIMIT` | 400 / 4000 | thought-sentence |

**逐条与规格的偏差**（均为实现细节，行为与 §3.3 一致）

1. **`roll-scheduler` 的 `offer` 加了「不许往回缩」**:`previous` 比手上这句短就不换
   （`previous.text.length > shown.text.length`）。规格没写这一条，但同一批 token 里
   「先按更长的旧句渲染过一轮、再收到更短的旧句快照」会让已经印出来的字被抹掉 ——
   真机上看到的是 `第一句。然后然后`。补了一条在旧代码上失败的测试
   （`previous 比手上的还短就不换`）。
2. **`thought-sentence` 的软切与回溯上限合成一个常量**（`MAX_HOPS = 16`）：规格的伪代码
   里是两个（普通分支 8、代码块分支 16），实际只有一处回溯循环，两个常量会让 biome 报
   「未使用」。语义不变：退不到就交空身份。
3. **`use-marquee` 导出 `node()` 而不是合并 ref**:容器要用同一个节点挂墨迹，`mergeRefs`
   在严格类型下过不了；改成让 hook 自己给节点读取器，少一层转发。
4. **组头的扫光只有一个例外**（规格 §5.9 已点名）：还没有一个字可写时（`placeholder`）
   仍戴扫光 —— 那时它是唯一能说明「正在进行」的东西。思考有字之后不再戴。

**测试**（规格 §7）

| 文件 | 覆盖 |
| --- | --- |
| `timeline/__tests__/rolling-line-css.test.ts` | 遮罩只挂在 `.ticker-window[data-scrolled]`、右端满墨、行高钉死、`will-change` 只按需 |
| `semantics/__tests__/thought-sentence.test.ts` | 中英句界、缩写（`e.g.` / `3.14` / `file.ts`）、省略号不断句、围栏内不取句、超长软切 |
| `timeline/__tests__/marquee-model.test.ts` | 逐帧模拟三条核心性质（匀速不抽、停笔停稳、快模型不遮字）+ 边界 |
| `timeline/__tests__/roll-scheduler.test.ts` | 三条时间规则、排队顶替、旧句收尾补完、少动效、删除路径（`fakeClock`） |
| `timeline/__tests__/use-marquee.test.ts` | 源码断言：循环里不读强制布局属性、不进 React、只写 `transform`、卸载断开 |
| `timeline/__tests__/ink-tail.test.ts` | 尾巴推进的账、`startTime` 钉时刻 |
| `timeline/__tests__/rolling-line.test.tsx` | 结构、三种 mode、墨迹开关、换 key 后旧句不残留 |
| `timeline/__tests__/process-group.test.tsx` | 接线：`data-variant` / `data-mode`、当前句不是最后一行、代码块停在最后一句人话 |

**验收**：`bun run all` 全绿（**2109 pass / 0 fail**，改动前基线 2102）。未动契约形状，
不需 `protocol:snapshot`；未碰 omp 隔离与环境，未跑 `core:probe`。

**真机核对记录**（规格 §8.1 的九条，以及 §8.2 的性能录制 —— 执行人填写）

- 长中文整段左划（匀速、右端不遮、左边柔和淡出）：
- 多句号（划到位、停一下、往上刷、新句从最左开始）：
- 快模型（刷得快不频闪、积压时跳到最新句）：
- 慢模型 / 停顿（平滑减速、最新字停在离右缘约 2 字）：
- 英文含 `e.g.` / `3.14` / `file.ts`（不误换句）：
- 代码块（停在最后一句人话上，无 ```）：
- `**重点**`（显示为「重点」）：
- 转去工具调用（刷到工具句；工具句超宽右对齐显示末尾）：
- 拖窄窗口 / 滚出视野再滚回（行高不变；不重播）：
- 系统「减少动态效果」（不划不刷，直接显示最新部分）：
- DevTools Performance 10 秒（逐帧只有 Composite/Paint、无逐帧 Layout）：
- 划动停止后无持续 rAF：
- 每秒 React 提交次数与改造前持平：

## R-21 思考行动画 v2：无遮罩的显示屏式滚动（2026-10-12）

**来源**：产品负责人交办的重构规格 `Project Refactoring Plan/思考行动画 v2：复盘与重构方案
（无遮罩·显示屏式滚动）.md`（仓库输入，不入库）。对象仍是过程组组头那一行，但这次不是调参，
是**换掉方向**：v1（R-20）把「最新的字落在哪」押在 JS 测量上，v2 把它交回给布局，JS 只管顺。

### 复盘：v1 的七个问题（规格 §2 的 R-1…R-7）

| # | 一句话 | 性质 |
| --- | --- | --- |
| R-1 | 左边缘用 `mask-image` 渐隐、工具行显示末尾：方向本身就不对，要的是显示屏边框式的硬裁 | 方案错（实现又放大） |
| R-2 | 几何前提错：组头是收缩包裹的 `inline-flex`，窗口宽度约等于内容宽度，句首永远被吃掉 2em | 几何前提错 |
| R-3 | 把「最新的字在不在窗口里」押在测量上：写满后目标冻结，整行不动、右端被硬裁（实测最多 236px / 约 17 个字） | 实现缺陷 |
| R-4 | 换句握手自相矛盾：两条规则互相抵消，每次换句都等满 1200ms，模型快时截止时间还被不断后推 | 方案错 |
| R-5 | 把滞后放在像素域：每批 token 一次台阶，追不平也追不稳，读起来一抽一抽 | 方案错 |
| R-6 | 墨迹：新字带透明度淡入（右端读起来像被遮），中间的字没有「刚写下」的样子 | 方案 + 实现 |
| R-7 | 验证方法错：只用 happy-dom 测，它没有布局，测试全绿而真机全错 | 验证方法错 |

**v2 的一句话**：**「对」交给布局，「顺」交给 JS。**

- **对交给 CSS**：窗口是 flex 容器，轨道 `margin-inline-end: auto` 吃掉正空余（放得下就靠左）；
  负空余不分给 auto 外边距，`justify-content: flex-end` 让轨道右端贴齐、多出来的从左边裁掉。
  于是「最新的字永远在右边缘以内」「放得下时句首不动」是布局每一帧直接给的性质，不靠测量。
- **顺交给 JS**，只做两件平滑的事：**字符域**把成批 token 摊成匀速字流（`ticker-pace`），
  **像素域**把每放出一个字带来的布局位移摊成连续滑行（`ticker-glide`，位移封顶 2.5em）。
  JS 出错最坏只是「不顺」，不会遮字、不会卡死。
- **换句只看时间**：`promoteAt = max(shownAt + 700, firstWaitingAt + 220)`，第一次算出来就定死。
- **全组头没有一处 `mask-image`**；工具行与落定态从头显示、放不下时末尾省略号。

### 改法与文件（规格 §5、§7 C1–C7）

| 提交 | 内容 |
| --- | --- |
| C1 | 止血：删掉遮罩与 `--cp-ticker-fade`；工具行、落定态改成从头显示 + 末尾省略号（R-1） |
| C2 | 新增 `ticker-pace.ts`：字符域放字（纯函数，11 条测试） |
| C3 | 新增 `ticker-glide.ts`：像素域滑行（纯函数，4 条测试） |
| C4 | `roll-scheduler.ts` 重写：只看时间，删掉 `settled` 握手，加 `waiting()` / `setImmediate()`（R-4，9 条测试） |
| C5 | 显示屏式滚动：`rolling-line.css` 重写 + 新增 `ticker-engine.ts` + `marquee-track.tsx` / `rolling-line.tsx` 重写 + 令牌与注释（R-2、R-3、R-5、R-6） |
| C6 | 删掉 `marquee-model` / `use-marquee` / `ink-tail` 与各自测试 |
| C7 | 新增真实布局检查 `tooling/checks/ticker-layout`（R-7）：`bun run check:ticker` |
| C8 | 本文档 |

| 模块 | 职责 |
| --- | --- |
| `timeline/ticker-pace.ts` | 纯函数：字符域放字。成批 token 进缓冲，按估计来字速度摊匀放出 |
| `timeline/ticker-glide.ts` | 纯函数：像素域滑行。把每放一个字的布局位移摊成连续运动，位移封顶 |
| `timeline/ticker-engine.ts` | 逐帧引擎：**唯一**碰 rAF 与 ResizeObserver 的地方；直接写文本节点、transform、`data-moving`，不进 React |
| `timeline/marquee-track.tsx` | `TickerLine`（React 只渲染窗口，里面的轨道归引擎）/ `StaticLine`（不动 + 省略号） |
| `timeline/roll-scheduler.ts` | 换句时机：`max(露面 700ms, 新句出现后 220ms)`，只算一次；等待期间更新的句子顶掉排队那句 |
| `timeline/rolling-line.tsx` | 容器：喂句、提升时换 key、按状态选格子；React 状态只有「换句」与「是否有句在等」 |
| `timeline/rolling-line.css` | 「对」：放得下靠左 / 放不下右端贴齐 / 左边缘直接裁 / 工具行与落定态省略号；全文无 mask |
| `tooling/checks/ticker-layout/` | 真实布局检查：Electron + 真实组件逐帧量「遮没遮字」，六场景 + 帧率自检 |

### 参数表（规格 §6，值即实现；取代 R-20 那一张）

| 常量 | 值 | 所在 | 为什么 |
| --- | --- | --- | --- |
| `TAIL_EM` / `--cp-ticker-tail` | 2.5 | ticker-glide / 令牌 | 静止时最新的字离右边缘的距离，也是 o 的上限。取 2em 时实测会顶到上限，顶到就是一跳 |
| `SET_EM` | 1 | ticker-glide | 滑行中希望保持的 o，约一个字。取 0.5em 时锯齿谷底会碰到 0，碰到就停一帧 |
| `SHIFT_WINDOW_MS` / `SHIFT_MIN_SPAN_MS` | 400 / 200 | ticker-glide | 估计布局推进速度的窗口与分母下限 |
| glide `CORRECT_MS` / `SPEED_SMOOTH_MS` | 300 / 150 | ticker-glide | o 偏离设定值时多久纠正 / 速度本身的平滑 |
| `MAX_PX_S` / `SETTLE_PX_S` / `MAX_DT_MS` | 1600 / 20 / 64 | ticker-glide | 滑行速度上限 / 停笔后最后一点的最低速度 / 单帧时间步上限 |
| `RATE_WINDOW_MS` / `RATE_MIN_SPAN_MS` | 800 / 200 | ticker-pace | 估计来字速度的窗口与分母下限 |
| `GAP_SMOOTHING` | 0.25 | ticker-pace | 到达间隔的滑动平均权重 |
| `BUFFER_GAP_CAP_MS` | 400 | ticker-pace | 缓冲最多压这么久的字（组头因此最多落后约一批） |
| pace `CORRECT_MS` / `SPEED_SMOOTH_MS` | 350 / 140 | ticker-pace | 积压偏离设定值时多久纠正 / 放字速度的平滑 |
| `MAX_CPS` / `FLUSH_CPS` | 240 / 480 | ticker-pace | 平时 / 收尾时的放字上限（字/秒） |
| `MAX_BACKLOG_CHARS` | 60 | ticker-pace | 积压超过就直接跳近（后台切回） |
| `MIN_CPS` / `TAIL_CPS` | 15 / 6 | ticker-pace | 有积压时的最低速度（停顿后最迟约 66ms 见第一个字）/ 积压不足一个字时的最低速度 |
| `INK_MS` | 450 | ticker-engine | 新字保持墨色的时长（只变颜色，不变透明度） |
| `MIN_DWELL_MS` / `FINISH_MS` | 700 / 220 | roll-scheduler | 一句话至少露面这么久 / 下一句出现后至少再等这么久 |
| `ROLL_MS` / `FAST_ROLL_MS` | 260 / 140 | roll-scheduler | 正常 / 跳过句子时的上下刷时长 |
| `ROLL_DISTANCE` / `ROLL_EASE` | 0.6em / (0.4, 0, 0.2, 1) | rolling-line | 上下刷的距离与曲线（去掉 v1 的 blur：Windows 上发糊） |
| `MAX_SENTENCE_CHARS` / `BACKSCAN_LIMIT` | 400 / 4000 | thought-sentence | 不动（本次没碰取句规则） |

**删除的参数**：`MAX_WAIT_MS`、`END_HOLD_MS`、`MIN_VISIBLE_MS`（并入 `MIN_DWELL_MS`）、
`LAG_SET_EM`、`--cp-ticker-fade`、`ROLL_BLUR_PX`、ink-tail 的 `INK_MS = 600`。

### 真实布局检查（规格 §8.4，R-7 的落地）

v1 栽在「happy-dom 没有布局」上，所以这一版把「最新的字有没有被裁」变成必须过的检查：

- `bun run check:ticker` 起真实 Electron、加载**真实的** `RollingLine` / `readThoughtSentence`
  与设计令牌，六个场景（匀速 / 成批 / 极快 / 慢速 / 拖窄 / 少动效）各一个进程；
- 每帧在 rAF 之后、绘制之后取样：用 `Range` 取第一个字与最后一个非空白字的矩形，比窗口矩形；
- 环境自检：每个场景先测 1 秒帧率，< 50fps 就报「环境不合格」并以退出码 2 退出，不给结论；
- 截图（1.5s / 4.5s / 8s）与原始采样落在 `.ticker-layout/`（已进 `.gitignore`）。

首次真跑记录（Windows 11，Electron 33 / Chromium，760px 列宽，14px 字号）：

| 场景 | 右裁 | 句首被裁 | 延迟 p50 / p95 / max | 应动未动 | sJ90 |
| --- | --- | --- | --- | --- | --- |
| 匀速 30 字/秒 | 0 | 0 | 131 / 313 / 344 | 6% | 0.19 |
| 成批 每 250ms 6 字 | 0 | 0 | 221 / 237 / 240 | 0% | 0.13 |
| 极快 200 字/秒 | 0 | 0 | 185 / 530 / 660 | 41%（已知局限） | 1.43（已知局限） |
| 慢速 11 字/秒 + 1.5s 停顿 | 0 | 0 | 107 / 204 / 339 | 5% | 0.12 |
| 匀速 + 拖窄窗口 | 0 | 0 | 134 / 309 / 344 | 3% | 0.20 |
| 成批 + 少动效 | 0 | 0 | 27 / 35 / 39 | 100%（预期：不滑） | 0.00 |

阈值按 §8.4：右裁与句首被裁**所有场景 = 0**；延迟 p95 默认 ≤ 500ms、极快 ≤ 700ms、
少动效 ≤ 100ms；应动未动 ≤ 10%、sJ90 ≤ 0.25 只对匀速 / 成批 / 慢速 / 拖窄四档判定，
极快与少动效两档只报数（见下面的偏差 3）。

### 逐条与规格的偏差（都是检查台自己的实现，产品代码逐字照 §5）

1. **`run.ts` 允许只跑一个场景**（`bun run check:ticker fast`）：调参时不必等六场，全跑仍是不带参数。
2. **采集的是「屏幕上那一句」的句首偏移**，不是当帧 prop 的偏移：延迟要量的是「这一批的字有没有
   印出来」，而换句有 220ms 的等待窗，这段时间里 prop 已经指向新句、屏幕上还是旧句。采样里另记
   `shownKey`（`data-line-key`）备查。这也是 `rolling-line.tsx` 要在那一格上写 `data-line-key` 的原因。
3. **「应动未动」与 sJ90 对极快、少动效两档不判定**：§8.4 的阈值表只给这两项四个场景的阈值，
   §10 又把极快档的顿挫明确列成已知局限 —— 给它定一个会失败的门槛，等于把「已知局限」变成
   「永远红的检查」。检查台照旧把数报出来，判定归 `judge()` 的 `null`。
4. **判定「正在出字」用的是「屏幕上印到的位置还没追上已经到达到的位置」**，不是「这个场景还在来字」：
   慢速档第 70 批之后有 1.5s 停顿（§2.8），那段时间句首当然不动，算进「应动未动」会把正确行为
   记成缺陷。为这一条给 `Sample` 加了 `arrived`（§8.4 本来就要求 recorder 记「已到达的源文本长度」）。
5. **检查用的思考文本按「单句也要放不下」来写**（每句 80–120 字）：短句在 760px 上放得下，
   放得下就没有滑行，抖动与应动未动两项会全 0 —— 检查看着全绿，其实什么都没查。这一条踩过一次：
   第一版检查文本的句子只有 40 来字，六场里五场的滑行指标恒为 0。
6. **`main.cjs` 等页面的 `window.__done`**（来字都印出来了、滑行也停了），不再干等固定时长；
   硬上限 20s，页面卡住也一定会交回结论。

### 测试

| 文件 | 覆盖 |
| --- | --- |
| `timeline/__tests__/ticker-pace.test.ts` | 11 条：摊匀、设定值、收尾加速、积压跳近、停笔放干、代理对不拆 |
| `timeline/__tests__/ticker-glide.test.ts` | 4 条：位移封顶、速度方向、静止归零、单帧步长上限 |
| `timeline/__tests__/roll-scheduler.test.ts` | 9 条：时间规则、排队顶替、`waiting` / `setImmediate`、StrictMode 反复订阅、删除路径 |
| `timeline/__tests__/rolling-line-css.test.ts` | 6 条护栏：全文无 mask / 渐隐、右端留白、工具行与落定态省略号、行高钉死、`will-change` 只按需 |
| `timeline/__tests__/rolling-line.test.tsx` | 13 条结构与时序：成批不一批一下、写满后连续左移、换句只上下刷、新句从第一个字写、墨迹、少动效、StrictMode 只有一条轨道 |
| `timeline/__tests__/process-group.test.tsx` | 接线：`data-variant` / `data-following`、当前句不是最后一行、代码块停在最后一句人话 |
| `tooling/checks/ticker-layout/__tests__/ticker-layout.test.ts` | 13 条：指标的纯函数（手写采样序列），含「停笔静止不算应动未动」 |

**验收**：`bun run all` 全绿（**2098 pass / 0 fail**）。未动契约形状，不需 `protocol:snapshot`；
未碰 omp 隔离与环境，未跑 `core:probe`。真实布局检查 `bun run check:ticker` 六场全 ✔。

### 审查执行待决（R-21 新增）

| 编号 | 日期 | 问题 | 阻塞的步骤 | 状态 |
| --- | --- | --- | --- | --- |
| Q40 | 2026-10-12 | 极快模型（≥ 200 字/秒）这一档仍有可见顿挫：实测应动未动 41%、sJ90 1.43（规格 §10 记为已知局限，原因是一帧要放 3 个以上的字、o 会顶到 2.5em 上限）。正确性不受影响（0 遮字、0 卡死） | 无（不在本次范围内） | 记录：真机上若感觉明显，再考虑让设定值随速度变化 |
| Q41 | 2026-10-12 | 换句的上下刷仍带 260ms 的透明度变化（§3.4 的既定点）。规格 §10 给了可选项：去掉 `initial` / `exit` 的 opacity 并把 `ROLL_DISTANCE` 改成 `1lh`，变成翻牌式 | 无 | 记录：等产品负责人看真机效果再定 |
| Q42 | 2026-10-12 | §9 的真机验收清单（Windows、深浅两色各一遍，14 条）未跑：需要安装包与真实模型 | 无（单测与真实布局检查已按规格落地） | 记录：等产品负责人真机复核 |

## R-16 追加：自动化列表卡片去掉「上次运行的结论」（2026-10-13）

**来源**：产品负责人交办的截图（外部输入，不入库）。R-16 让列表卡片在指令下方画一条
`run.summary`（`automation-list.tsx` 的 `Conclusion`），而 summary 正是 agent 用
`automation_report` 交的那段正文 —— 在「报告当前时间与工作区状态」这类任务上，它就是那次
运行里 agent 的整段回答，摆在任务卡片上读起来像卡片里夹了一条对话消息。

**改法**（只动 UI，不改契约，`PROTOCOL_VERSION` 不动）：删掉 `Conclusion` 组件与它的挂载点，
卡片只画任务定义 —— 标题、指令、计划、「已运行 N 次」。运行结论仍有四条出口，不受影响：
编辑页的运行历史（`automation-run-history`，逐条列 `run.summary` 与系统消息）、对话里的
`automation_report` 工具卡、系统通知的正文（`notice.ts`）、agent 的 `automation_runs` 工具。

**测试**：新增 `features/automations/src/ui/__tests__/automation-list.test.tsx` 两条 —— 卡片画
标题 / 指令 / 计划 / 次数；`lastRun.summary` 与「需要关注」不上卡片（旧代码上第二条红）。

**验收**：`bun run all` 全绿（**2043 pass / 0 fail**，含新增两条）。未动契约形状，不需
`protocol:snapshot`；未碰 omp 隔离与环境，未跑 `core:probe`。此前有一次整仓红是别处并行的改动
删了 `features/browser/src/host/picker-runtime.ts` 还没收尾（typecheck 报 `host/index.ts` 的
TS2307），与本项无关；那半边收尾后复跑即全绿。


## 目录与文件归属整理：删死文件、收拢与拆分（2026-10-13）

**来源**：产品负责人交办的目录整理清单（外部输入，不入库）。**只动目录与文件归属，不改行为**；
层级（contract / core / host / ui、packages 分层）一律不动。

**先删**（全仓无人引用，逐条脚本核过）：

- `ui/threads/threads-store.ts`（513 行旧 `ThreadsStore` 类）——线程列表真正在用的是
  `ui/session/threads-store.ts`，两份并存会让人以为线程状态有两处。
- `ui/components/semantics/file-meta.ts` + `file-size.ts`——`fileExtensionLabel` /
  `fileMetaLabel` / `formatByteSize` 逐字复制自 `ui/timeline/timeline-contract.ts`。
- `ui/configuration/model-choice-visibility.ts`（`projectVisibleModelChoices` 无调用方）。
- `packages/transcript/src/upstream/contract/events.ts`（`transcriptEventSchema` 等 6 个名字全无引用，
  `index.ts` 也没导出它）。
- `packages/engine-omp/src/projector/tool-view.ts` + `projector/__tests__/tool-view.test.ts`：
  生产代码无人用 `toolTitleOf` / `toolSummaryOf` / `toolResultTextOf`，只剩测试在测它；
  真正在用的工具词汇在 `features/conversation/src/ui/components/timeline/tools/`。

**合并 / 收拢**：

1. **conversation 的 `ui/` 统一成一条规则**：一个领域的 store、纯逻辑、context / hook 住
   `ui/<领域>/`，`ui/components/<领域>/` 只放组件与样式。线程 → `ui/threads/`；
   草稿 → `ui/composer/`（并删掉只有 1 个文件的 `ui/interjection/`）；会话控件 →
   `ui/configuration/`（并删掉只有 1 个文件的 `components/configuration/`）；
   `components/transcript/`（三个 context / hook，不是组件）并进 `ui/transcript/`；
   `components/skin/` 去掉（唯一的 `surface.css` 挪到 `components/surface.css`）。
   最后 `ui/stores/` 只剩会话层的东西，整体改名 `ui/session/`。
2. **去掉转发壳** `components/composer/attachment-intake.ts`：三个引用方直接引
   `ui-api/composer-assets`。
3. **跨模块重复副本收进包**：`focusOnMount`（两份逐字相同）→
   `packages/design-system/src/focus-on-mount.ts`；`WINDOW_BACKGROUND`（两份逐字相同）→
   `packages/host-kernel/src/window-colors.ts`。两个包入口各加一行导出，四份副本删除。
4. **`features/review/src/ui/components/` 去掉**：测试挪走后只剩 `review-pane.tsx` + `.css`，
   而别的组件本来就在 `ui/` 下平铺。

**拆分**：

5. `components/timeline/`（48 个文件）按块分成 `prose/`、`ticker/`、`wave/`、`tools/`；
   951 行的 `timeline.css` 跟着拆：绝大部分（`.timeline-prose*`）归 `prose/prose.css`，
   `.timeline-error` / `.timeline-user` / `.timeline-plan` 落回各自组件旁边。
6. `omp-tool-view.ts`（1413 行）按工具族分家，入口只留 `HANDLERS` 与 `ompToolView()`。
7. `ui/index.tsx`（1026 行）拆成 `ui/setup/` 五段，`index.tsx` 只按顺序调用。
8. `packages/engine-omp/src/` 的「一条会话」十来个文件收进 `src/session/`，
   对应测试跟着进 `src/session/__tests__/`；根目录只留引擎级的东西。

**零碎**：3 个放错位置的测试归入 `__tests__/`；删 `apps|features|packages/.gitkeep`；
根 `scripts/` 并到 `features/python/scripts/`（`python:pin` 路径与 `biome.json` 的
`"scripts/**"` 一起改，`tooling/refs/sync.ts` 的工程模式换成 `features/*/scripts/tsconfig.json`）。

### 与清单的偏差

1. **`timeline/tools/` 里的三个纯逻辑文件挪到了 `ui/timeline/tools/`**（清单也是这么写的）：
   `ui/transcript/transcript-projector.ts` 在引它们，而按第 1 条规则「纯逻辑住 `ui/<领域>/`」，
   `components/` 下只留组件与样式。所以 `components/timeline/tools/` 现在装的是六张工具卡与样式。
2. **`writeView` 的 `xd://` 委派用一格迟登记回调**，没有直接互相 import：
   `views/files.ts` 要用整张 `HANDLERS` 表再认一次名字，而表在 `omp-tool-view.ts` 里、
   入口又 import 每个视图文件 —— 直接引就成环（depcruise 的 no-circular 会红）。
   `view-kit.ts` 出 `registerViewLookup` / `viewOf`，入口在模块求值末尾登记。
3. **`.timeline-plan*` 四条规则没有对应的活动组件**（`timeline-row.tsx` 的 `case 'plan'` 返回
   `null`）。清单说这些规则「放回各自组件旁边」，但那个组件不存在；为免静默删掉规则，
   仍收在 `timeline/plan.css`，由 `timeline-row.tsx` 引入。
4. **`build` 用的那两个项目名保留**：`features/python/scripts/tsconfig.json` 的
   `extends` 深度从 `../tooling` 改成 `../../../tooling`、`references` 改成 `../src/core`，
   并把 `features/*/scripts/tsconfig.json` 加进 `tooling/refs/sync.ts` 的工程模式。
5. **biome.json 的复杂度覆盖跟着新路径改了三处**（`session/session-port.ts`、
   `setup/contributions.tsx`、`session/omp-session-adapter.ts`）——这些文件本身没改行为，
   只是路径变了；不改就是「覆盖静默失效、闸门突然变红」。

### 验收

`bun run all` 全绿（**2040 pass / 0 fail**，263 个文件）。基线是 2043 pass / 264 个文件：
-`projector/__tests__/tool-view.test.ts`（清单要求删的死代码测试），
-2 条属于它的断言；+3 条是 `ui/transcript/__tests__/use-slice-frames.test.tsx`
（移动 `components/transcript/` 时被误删，已按 HEAD 原文恢复并重定 import）。未动契约形状，
不需 `protocol:snapshot`；未碰 omp 隔离与环境，未跑 `core:probe`。
**`bun run check:ticker`（补跑通过，六场几何全 ✔）**：改到了 `timeline/rolling-line*`、
`ticker-*`、`roll-scheduler*` 的路径，但文件内容逐字未动 —— 除 `rolling-line.tsx` 里 `cx`
的 import 相对深度外，其余七个文件与基线 blob 哈希 **SAME**。六场里 `右裁` 与
`句首被裁` 全部为 0（这正是这条检查存在的两条理由）；`steady` 的 sJ90 在 0.23～0.29
之间抖动（阈值 ≤ 0.25），三次复跑 0.23 ✔ / 0.27 ✘ / 0.24 ✔ —— 是这台机器的测量噪声，
与被测文件无关。

**环境事故（与本次重构无关，已修）**：`bun dev` 报 `Error: Electron uninstall`。
根因是上一个提交 `2a3548e6`「提升依赖版本」把 electron 从 `^44.5.1` 提到 `^44.7.0`，
而 44.7.0 的 postinstall **下载失败后没有重试**，`node_modules/electron/` 下只有
`cli.js` / `index.js`，没有 `dist/` 也没有 `path.txt`；`electron-vite` 的
`getElectronPath()` 读不到 `path.txt` 就抛这句话。修法：从镜像取官方 zip
（sha 与 npm 上的一致，158293649 字节，zip 完整、内层 `electron.exe` 246302208 字节），
解到 `node_modules/electron/dist/` 并写 `path.txt`（内容 `electron.exe`）。
`bun install` 不会覆盖已存在的 dist，所以这次修复是持久的。修完 `bun dev` 起来：
host ready、core ready（protocol 15 / engine 18.10.3），窗口标题 `Poietica`。
**待决**：`tooling/checks/ticker-layout/run.ts` 的 `ELECTRON` 常量写死了
`node_modules/electron/dist/electron.exe`，改走 `require.resolve('electron')` + `path.txt`
更稳（isolated linker 下前者不成立）。


---

## 代码审查页：按 synara 复刻三栏（PR 列表 / 详情 / 信息栏）

**目标**：`review.code` 表面此前只有一句「这一页的正文还没写。」；本次把它做成参考实现
（synara，`D:\xiaojianc\synara-ref`，只读）那一页的样子：**左列表 + 中详情 + 右信息栏**，
事实源是工作区远端仓库的 GitHub pull request。

### 与参考实现的偏差

1. **事实源从「GitHub 应用内集成」换成 `gh` CLI**。参考实现自带 GitHub 客户端与限流处理；
   本仓没有 GitHub 集成，也不该为一个页面新引入一套 OAuth。改用开发机上已登录的 `gh`
   （读 `gh api` / `gh api graphql`，写 `gh pr comment|edit|merge`）。代价与边界写在这里：
   没装或没登录 `gh` 时整页降级为一句说明（`review.github_unavailable`），而不是空白或报错。
2. **不做 diff 正文**。参考实现的 Changes 标签接的是它自己的 diff 渲染管线；本次只给
   「N files changed +553 −358」的统计与一句「去 GitHub 上看」的诚实说明，不假装能读 diff。
   审查面板（右坞 `review.panel`）本来就是本仓的 diff 阅读处，两者不重复造。
3. **Issues 一栏留空（计数恒为 0）**，PR 之外的条目本次不做；过滤标签照参考实现保留
   `All / PRs / Issues` 三档，Issues 选中时为空列表。宁可空着，也不把 issue 伪装成 PR。
4. **评论与评审为只读 + 发评论 + 请求评审**；参考实现的 `Send to agent` 在这里落成
   「把这条 PR 的引用插进会话输入框」（不自动发送）—— 本仓的 agent 入口是会话输入框，
   与参考实现的 side chat 不是一回事。

### 架构落点（按本仓守则，不是照抄参考实现的目录）

| 关注点 | 落在 |
| --- | --- |
| 契约 | `features/review/src/contract`：命名空间 `github`，七个方法与四个错误码 |
| 读写 GitHub | `features/review/src/core`（Core 进程，`gh` 薄封装；只读 + 三种写操作） |
| 页面状态机 | `features/review/src/ui/pr-store.ts`（视图三块共用一个 store） |
| markdown 渲染 | conversation 经新的 `MarkdownRendererToken`（`ui-api`）提供 —— 能画 markdown 的
Prose 属于会话时间线，功能之间不得互相 import `ui`（守则 3），所以走服务令牌而不是复制一份 |

**协议版本 15 → 16**，快照已重新生成（七个方法与四个错误码）。

### 验收

- `bun run all` 全绿（**2075 pass / 0 fail**，265 个文件；typecheck 745 + 960 文件、lint 与 depcruise 全过）。
- 真机（真实 Electron + 真实组件 + 真 GitHub 数据）：新增 `bun run check:review-page`，
  12 项几何/内容断言全过，截图落在 `.review-page-shots/code-review-page.png`。
  三栏实测 416 / 674 / 352 px（左 clamp 命中上限、右 22rem 分毫不差、中栏最宽），
  页面整体不滚（滚动只在中栏与左栏列表内），标题未被截断，四张卡与 PR#3 的真实数据
  （conflicting、+553 −358、Frontend 绿 / Rust 红 / Windows Desktop 红）逐个对上。
  这一条不进 `bun run all`：它要真实 GPU、真实窗口与一个登录过的 `gh`。
- 为什么必须跑真机而不是 happy-dom：三栏的宽度、滚动归属与标题截断在 happy-dom 里都量不出来
  （那里没有布局）。第一次跑真机就抓到一个 happy-dom 永远发现不了的真缺陷 —— 栅格行高是默认的
  `auto`，正文一长就把整页顶出视口，而外壳的 `overflow: hidden` 只是把它裁掉，中栏底部再也够不着；
  改成 `grid-template-rows: minmax(0, 1fr)` 才对。
- 同一次真机检查还暴露了另一件事：**冒烟必须用真的 Tailwind 产物**。`Bun.build` 不认识
  `@import "tailwindcss"`、也不知道 `@source` 扫哪些文件，直接打包出来的 CSS 里一个工具类都没有；
  那样量到的「三栏」其实是三个堆叠的块。所以编译步骤单开
  `apps/desktop/scripts/compile-styles.ts`（走 `@tailwindcss/vite`，与真实构建同一条路），
  `@tailwindcss/node` 随之进 catalog 与 `apps/desktop` 的依赖。

### 待决问题

1. **Issues 一栏恒为 0**：过滤标签照参考实现留了 `All / PRs / Issues` 三档，但 issue 本次不做，
   选中 Issues 是空列表。要做的话要先决定「issue 的详情页长什么样」。
2. **Changes 标签不画 diff**：只给「N files changed」的统计与一句「去 GitHub 上看」。
   本仓的 diff 阅读处是右坞的「审查」面板；要不要把 `packages/design-system/diff` 接进这一页，
   取决于产品要不要「一个页面读完全部改动」。
3. **`gh` 是这一页的硬前提**：没装或没登录时整页降级成一句说明。若以后要自带 GitHub 集成，
   `core/gh.ts` 是唯一需要换掉的那一层（`pr.ts` 的映射与 UI 都不用动）。


### 产品负责人验收后的第二轮改动（2026-10-14）

三条都是主管人看过真机之后的原话，逐条照做：

1. **底要 #181818、左右不要分割线**。底本来就该是页面地色（深色主题的 `--ui-ground` = `--ui-palette-dark-950` = `#181818`），
   之前那版写的是 `--color-background` 并且给中栏画了 `border-inline`。现在整页改用 `--color-ground`，
   三栏的左右边框全部去掉（真机断言逐栏数过：`0px/0px/0px`）。
2. **四个动作移到右栏上方（右移）**。之前工具条只属于中栏，四个动作因此缩在中栏右上角；
   现在工具条提到页面顶层、横跨整页（实测宽 1442 = 视口宽），动作落在窗口最右
   （实测 right=1430，视口 1442）。标签仍在中栏那一段的起点上方。
3. **合并状态与检查项的 UI 太简陋**。之前是一颗 8px 的纯色圆点，既没有形状也没有语义。现在照 synara：
   - 右栏**不再画卡片**，改回它那套「标题 + 内容」的素面节，节间留白 28px（`gap-7`）；
     卡片框在深色底上会变成四条亮边，比内容还抢眼。
   - 合并状态：有冲突 = 红色的 `GitMergeConflict` 字形 + 「Conflicts with main」；
     能合 = 绿底反白的对勾；其余（被拦 / 落后 / 草稿 / 未知）退回这条 PR 自身的状态字形。
   - 检查项：绿底反白勾 / 红底反白叉 / 琥珀转圈 / 灰色虚线空圈，四种占同一个 16px 光学方框；
     超过 6 条时出现 `View more`（与 synara 同数同文案）。
   - 一个实现细节：`lucide` 的 `fill-current` 会把整块圆面连笔画一起涂满，勾与叉反而消失（成了实心圆点）。
     synara 的实心字形来自另一套图标族（Central 的 `variant="fill"`），`lucide` 没有对应物，
     所以这里是「着色实心圆 + 一枚反色小字形」自己拼出来的，观感与它一致。

**验收**：`bun run all` 全绿（**2075 pass / 0 fail**）。真机 `bun run check:review-page` 扩到 **15 项断言**
（新增：页面底 = `rgb(24,24,24)`、三栏左右边框为 0、Merge 按钮贴到窗口右缘、工具条横跨整页、右栏四节齐全、
状态字形已绘制），全过；另存一张右栏特写 `.review-page-shots/info-column.png` 供人眼比对。


### 第三轮：三栏对齐、动作归位、滚动条与头像（2026-10-14）

主管人指出的五件事，逐条落实。其中第一条是我上一轮**理解错了**，先认下来：

1. **三栏都下沉、中间空出一条**（本轮新报）。根因是我把「四个动作」做成了一条**横跨整页**的顶栏，
   而它里面只有右侧那几个按钮 —— 那一条占掉了整行高度，左、中两栏因此被顶下去，整行左侧空着。
   动作属于**右栏**，不属于页面：现在它们住在右栏自己的第一行，正好在 Merge status 那些节的上方，
   左、中两栏与右栏同为 y=0。真机新增断言「左右中三栏顶边齐平」，并且**先把量几何的 rect() 补上 y**
   —— 没有 y 的那版断言是空转的（三条 undefined === undefined 也能过），这一点本身就该被记一笔。
2. **中栏滚动条隐藏**。中栏的正文容器加 `scrollbar-width: none` 与 `::-webkit-scrollbar { display: none }`：
   仍然能滚（正文本来就长，禁掉就看不全），只是不画那条槽。真机断言量 `scrollbarWidth === 'none'`。
3. **标签不要动，动作要上移**。这两件事曾被我看成一件：上一轮我把整条工具条一起上移，这一轮又整条
   移回来，两次都不对。现在拆成两个组件 —— `PrDetailTabs` 留在中栏正文上方（它原本的位置），
   `PrDetailActions` 只把四个动作送到右栏顶行。真机断言分别量它们：标签与中栏同宽、动作行只在右栏内。
4. **头像要显示**。两个原因，都不是「忘了写」：
   - 列表行与详情头本来就没画头像，只写了作者名 —— 现在补上 `Avatar`（`pr-format` 之外的新文件），
     列表行的 meta 行是「状态字形 + 头像 + 作者 · 相对时间 …… #编号」，详情头是「头像 + 作者」。
   - **渲染进程的 CSP 把头像主机挡住了**：`img-src` 是白名单，原来只有 `'self' data: blob: poietica-asset:`，
     `avatars.githubusercontent.com` 不在里面 —— 图片会被 Chromium 静默拦掉（页面只是没有头像，
     控制台才有一条 CSP 报告）。开发版与安装版两张表都补上了这一个主机，不放行任意 https。
     头像只用 GitHub 明确挂在该 actor 上的 `avatarUrl`；加载失败退回首字母圆牌（与参考实现同）。
5. **状态胶囊与它的菜单**（主管人给的第 5 张图）。详情头现在有那枚胶囊：词、色、字形都读
   `pullStatePresentation`（开着 = 绿、草稿 = 灰、**有冲突 = 红 + GitMergeConflict**、已合并 = 紫、已关闭 = 灰），
   点开是 `Draft / Ready for review` 两项单选，经新契约方法 `github.setDraft` 走 `gh pr ready [--undo]`。
   合并与关闭的 PR 不给切换入口（GitHub 也不给），只报状态。
   冲突改状态词这件事顺带修正了一处旧行为：原来「开着 + 有冲突」写「Open」，现在写「Has conflicts」——
   草稿仍然优先。对应单测按新规则改了，并补了两条（草稿优先于冲突、被拦/落后不改状态词）。

**协议版本 16 → 17**，快照重生成（新增 `github.setDraft`）。

**验收**：`bun run all` 全绿（**2078 pass / 0 fail**，+3 条单测）；真机 `bun run check:review-page` 扩到
**20 项断言**（新增三栏顶边齐平、动作行只在右栏内、标签留在中栏、中栏滚动条为 none、页面底 #181818），全过。

## V-01 吉祥物运行时从上游 JS 迁为 TS（2026-10-14）

**背景**：`features/conversation/vendor/aora-bot/emotion-ball/js/` 下四个 `.js` 是上游第三方 IIFE，
靠副作用导入往 `window` 挂引擎，没有任何类型。本次把四个文件迁成 `.ts`（B 方案：结构移植 + 补类型，
不重写），并搬进本功能的实现目录。

**最终位置**：`features/conversation/src/ui/components/mascot/engine-runtime/`
（`rings.ts` / `emotions.ts` / `ball.ts` / `engine.ts` / `types.ts`）。
原先暂放的 `features/conversation/vendor/aora-bot/` 整个目录已删除——包括上游的
`LICENSE` 与 `NOTICE.md`（维护者 2026-10-14 确认不再保留）。

**做了什么**：IIFE 拆成 ES 模块、`window.EB_RINGS`/`window.EmotionBall` 改成 import、
`console.*` 改成注入 logger、`Engine.prototype` 改成 `class Engine`；数据文件的数据本体逐字未改；
新增 `types.ts` 收三层共享类型；消费侧 `emotion-ball-runtime.ts` 改为直接 import，
`emotion-ball.tsx` 一行未改；删掉不再需要的 `vendor-js.d.ts` 模块声明桩。

**等价性证据（实测）**：把上游原始 `.js` 与迁移后的 `.ts` 放进同一 happy-dom 环境，固定随机数与
`performance.now`，跑同一组输入，比对（a）`config.exportConfig()` 逐字节、（b）分组与列表、
（c）**32 套表情 × 3 种形状（blob/wedge/gem）**连续切表情 + 自旋 + 注视的逐帧 SVG 逐字节。
三项一致（唯一差异是梯度 id 计数 `eb0g` vs `eb1g`，源于旧实现每次求值脚本都重置模块计数器，
非行为差异）。对拍结论冻结为 `features/conversation/src/ui/components/mascot/__tests__/mascot-baseline.test.ts`。
上游 `.js` 随后删除（同目录 `.ts` 优先，留旧文件只会造成「改了没生效」的静默错误）。

**偏差 1（两条 biome 规则例外，精确到文件）**：`biome.json` 的 `overrides` 新增一段，
只对 `engine-runtime` 的 5 个文件生效：
- `noInnerDeclarations: "off"` —— 上游用 `var` 的函数作用域在同一函数内共享同名变量
  （`e`/`a`/`r`/`node`/`h`/`n`/`s`/`i` 等 15 组重复声明），机械改成 `let` 会直接冲突或改变语义；
  共 76 处，不是能一次替换的机械改动。
- `noExcessiveCognitiveComplexity` 上限 15 → 80 —— 上游把构建 / 投影 / 彩带 / 撒花写在同一个
  `createBall`（最高 79）、`_compose`（69）里；拆函数必然动渲染顺序与状态机求值次序，属于重写。
  仓库里同类先例见 `biome.json` 既有的 6 处复杂度上限调整（20/25/30/40/52）。
其余规则（format、useTemplate、noUnusedVariables 等）已用 `biome check --write` 修到干净；
剩 24 条 `useTemplate` 提示是 info 级、不阻断闸门，且属于 unsafe fix——保留上游字符串拼接，
避免任何行为差异。

**偏差 2（`var` 与分号风格保留）**：同上，逐字等价优先于套本仓风格。

**过程中真实发生过的一次退化**：类型清理阶段曾误删 `lerpPose` 的 `else po[k] = vb` 分支
（负责把 `ring` 这类非数值字段原样直传）。行为基线测不出这条（它只断言帧有变化），是靠回查
git 里原始实现 + 专门的「表情切换过渡帧」对拍发现的，随后修复并复验。教训：这个目录的改动
必须跑对拍，不能只靠类型检查与基线断言。

**闸门口径变化**：因 vendor 目录消失，三处对它的排除已一并移除——
`biome.json` 的 `!features/conversation/vendor`、`tooling/depcruise/config.cjs` 的
`doNotFollow`/`exclude` 里的 `vendor`（及其注释）、`tooling/checks/no-raw-errors.ts` 与
`tooling/checks/no-biome-ignore.ts` 的 `SKIP_DIRS` 里的 `vendor`；
`tooling/refs/sync.ts` 的 `PROJECT_PATTERNS` 也去掉了为 vendor 加的那条模式
（新位置在 `src/ui` 工程覆盖范围内，不需要独立工程）。depcruise 的自检用例同步改名。

## 用官方能力替换手搓代码（2026-10-14）

**来源**：产品负责人交办的审查任务「使用官方能力替代手搓代码，可以接受加依赖或者减依赖或者换依赖，
先出审查报告」（外部输入）。审查报告先交，获批后按优先级逐项落地。全仓 1,033 个 TS 文件 / 139k 行。

**结论：三处真缺陷（前两条是功能性的），三处纯删除，一处闸门换口径，一处依赖清理。**
凡是「看起来该换、实测换了会坏」的（`line-splitter` / `which` / `id` / `thought-sentence` /
吉祥物缓动 / `formatTokens` / `transcript/upstream`），一律只补注释说明理由，不动代码。

### 1. relay 协议缺 `discardedTabsProtocol` —— 浏览器工具此前完全不可用（真缺陷）

`relay-protocol.ts` 自述「与 omp 18.5.0 逐字对应」，而 catalog 早已是 **18.10.3**，这次升级没核
这一个文件（AGENTS.md §11 点名要求核对）。18.10.3 的 `relay/bridge.ts` 的 `#eligible()` 拿
`discardedTabsProtocol` 当能力闸门：对不上的实例**每张标签都不 eligible** —— `Target.getTargets`
返回空、`/json/version` 报 `ompExtensionDiscardedTabsProtocol: "0"`，`probe.ts` 于是判成
`outdated-extension`，agent 每次用浏览器工具都拿到「扩展过期，请跑 `omp browser-relay install`」
（而扩展根本不归我们装）。

**证据（实测，不是读源码推的）**：起一台真 relay、用 Poietica 真实的 `createRelayClient` 接线：

| hello 形状 | `waitForRelayExtension` | `/json/list` |
| --- | --- | --- |
| 现状（无该字段） | `outdated-extension` | `[]` |
| 补上 `discardedTabsProtocol: 1` | `ready` | 那张标签可发现 |

**改法**：`relay-protocol.ts` 加 `DISCARDED_TABS_PROTOCOL_VERSION = 1` 与 `TabSnapshot.discarded`
（Electron 的 `WebContentsView` 没有 Chrome 的省内存丢弃机制，恒 false —— 不冒领一个「激活就会自己
活过来」的状态）；hello 带上该字段；顺带补 `createTab.active`（omp 的 `newPage` 带
`background:true` 时发 `active:false`，此前不认这个字段，agent 开后台标签会抢用户焦点），
后台标签在「当前没有活动标签」时仍接管活动位（否则面板一张都不画）。

**收益**：浏览器工具从「每次都报扩展过期」恢复可用；两处协议漂移一次补齐。不动 engine 端口、
不升 `PROTOCOL_VERSION`。测试 +5（hello 形状、能力字段、active 透传、后台标签不抢焦点、
无标签时后台标签接管活动位）。`features/browser` **170 pass**。

### 2. 输入框的 Ctrl+Z 是死键（真缺陷）

`prompt-input.tsx` 没挂 `HistoryPlugin`，而 Lexical 内核把 Ctrl+Z 拦成 `UNDO_COMMAND` 并
`preventDefault`（`Lexical.dev.js` 的 keydown 表 + `historyUndo` 分支，注释原文：
「with no history extension registered undo becomes a no-op rather than native undo」）——
**原生撤销与命令两头都落空**。实测 `dispatchCommand(UNDO_COMMAND)` 返回 `false`（无监听者）。

**改法**：`PromptInput` 根上挂 `<HistoryPlugin />`（`@lexical/react` 已有 `@lexical/history`
依赖，**不需要新增依赖**）。

**必须一起处理的副作用**：`clearDraft`（提交成功后清空正文）是普通 `editor.update()`，装了历史
之后它成为可撤销的一步 —— 用户发送后按 Ctrl+Z 能把正文捞回来，此时回车就是**一次静默重发**。
所以 `clearDraft` 里补 `CLEAR_HISTORY_COMMAND`，让「发送」成为不可逆的边界。

**反向验证**（两条都做了）：注掉 `<HistoryPlugin />` → 第一条用例红
（`Expected: true, Received: false`，正是 v1 的行为）；注掉 `CLEAR_HISTORY_COMMAND` → 第二条用例红
（`Expected: "", Received: "这句要发出去"`，捞回了已发出的正文）。两处都是真实承重的。

**过程中查清的一条语义**：Lexical 的第一次更新不可撤销（`getUndoEntry` 在 `current === null` 时
返回 null，源码注释写明 "mirrors the way the first update of an editor is not undoable"）。
用例因此写两次改动，并在注释里记下这条，免得后人以为是 bug。测试 +2。

### 3. 纯删除与替换（各闸门全绿）

- **`process-kit` 的 `quote.ts` + `streaming.ts`（102 行死代码）**：`git grep` 确认包外零引用，
  包内只有 `index.ts` 的两行 re-export 与它自己的测试。`quote.ts` 的注释自己就写着「正常调用一律用
  参数数组，不需要它」—— 而全仓确实都用参数数组。删文件 + 2 行导出 + 20 行测试。
- **`compile-styles.ts` 的 `capture-css` vite 插件（13 行）**：文件头注释断言「css 只能靠
  `generateBundle` 取回」，**这个前提是错的** —— `write: false` 之下产物就在 `build()` 返回值里。
  实测新旧产物：CSS 正文**逐字节相同**（100 489 字节），旧版多写出的 12 字节只是 Vite 的
  `/*$vite$:1*/` 开发标记。
- **`refs/sync.ts` 的 21 行手写 JSON 格式化器** → `biome format --stdin-file-path`：那种「手抄
  biome 规则」的复刻一旦上游改规则就静默分叉。合规性实测：仓里**全部 85 个 tsconfig.json** 与
  biome 的输出**逐字节相同**（含 `include: ["src"]` 这种写在一行的标量数组）。`cwd` 与
  `--config-path` 都钉在仓库上 —— root 在单测里是临时目录，不钉会退回 biome 内建的 Tab 缩进。

### 4. 换掉手搓闸门：`no-raw-errors.ts`（62 行正则）→ 官方 AST 闸门

手写版逐行扫文本，靠「去注释去字符串」续命。换成 **biome 内置 `useThrowOnlyError`**
（`throw '...'`）+ **GritQL 插件** `tooling/checks/raw-errors.grit`（`new Error(` /
`AggregateError` / `TypeError` / `RangeError` / `SyntaxError` / `URIError`）。

**这不是等价替换，是更准**：同一份对照输入（生产文件），旧版把
`export const x = 'return new Error( 在字符串里'` **判成命中**（误报），新版不报；注释里的示例两者
都不报。两个方向都验过：真 features 跑出新旧同为 0 命中；塞一个 `throw new Error('x')` 进生产文件，
新版报并 `exit 1`；同一文件里测试路径被 `includes` 的 `!` 规则排除。

**踩到的坑（已写进 biome.json 的插件 includes）**：插件的 `includes` 只认 `**/features/**/*.ts`
这种形状；写 `features/**/*.ts`（不带前导 `**/`）会**静默不生效** —— 插件看着配了，其实一次没跑。

### 5. 减依赖：14 个 feature 声明了没人 import 的 `zustand`

`zustand` 在 14 个 feature 的 `package.json` 里声明，而 `git grep "from 'zustand"` 在
`features/**` 里**零命中**（那 3 处非 package.json 命中全是注释）。feature 拿的是
`ui-kernel` 的 `createFeatureStore` 封装（`FeatureStore` 由 ui-kernel 转出），不直连 zustand。

**验证**：删完 `bun install` → typecheck（750 文件 / 80 工程 + 966 文件）全过、depcruise
**0 violations**、`bun run all` **2089 pass / 0 fail**。残留的旧符号链接由 `bun install` 按
`package.json` 重建（实测：删掉目录再 install 不会重现），全仓现在只有 `packages/ui-kernel`
依赖 zustand。

### 验收

`bun run all` 全绿：**2089 pass / 0 fail**（266 文件 / 10 455 断言）。基线 2090 pass 与本次的差
= 删除的 `quote.test.ts` 7 条 + 新增的 7 条（浏览器 5 + 撤销 2）− 1（原 hello 形状用例并入新断言）。
未动契约形状，**不需 `protocol:snapshot`**；未碰 omp 隔离与环境，未跑 `core:probe`。

**未做（明确记录）**：审查报告里的 #10（MCP 的 `bearerTokenEnvVar` / `toolTimeoutMs` /
`enabledTools` / `disabledTools` 四个键 omp 根本不认，且名称校验与 omp 的 `validateServerName`
错位）留作待决 —— 它要改 UI 字段与校验归属，属产品决定，不在「用官方能力替换手搓」的范围里。
另有三条「官方能力存在但跨边界成本高于收益」也记入待决：omp 的 `searchSmitheryRegistry`、
`node:sqlite` 的 `setAuthorizer`（受「一条连接服务多模块」架构限制）、`Bun.Archive` 解压
（需先确认路径穿越防护）。

### 待决问题

| Q | 日期 | 问题 | 现状 | 处置 |
| --- | --- | --- | --- | --- |
| Q43 | 2026-10-14 | `docs/omp-sdk-reference.md` 仍标 18.5.0，而 catalog 是 18.10.3。发现 1 的 relay 缺陷正是这份文档没跟上导致的 | 无（本次按实测核对了 relay 协议并补了文件头注释） | 记录：升级 omp 时按 AGENTS.md §11 重新抽取该文档 |
| Q44 | 2026-10-14 | MCP 配置的四个死键（`bearerTokenEnvVar` / `toolTimeoutMs` / `enabledTools` / `disabledTools`）+ 名称校验与 omp 的 `validateServerName` 不一致（`foo/bar` 能过表单、到 omp 才抛错，提示回不到字段旁） | 无（本次未动） | 记录：要改 UI 字段与校验归属，属产品决定 |
| Q45 | 2026-10-14 | `relay-protocol.ts` 仍是 omp 内部协议的**副本**（omp 未导出稳定契约）。根治要么在 engine 端口转出协议，要么每次升级手工核 | 已补文件头注释与具名常量 | 记录：升级 omp 时必核这一个文件 |

## MCP 名单接上 omp 的在线目录（2026-10-14）

**来源**：产品负责人「你说硬编码 6 条 MCP 名单，omp 自带实时 registry 检索，那就改成 omp 官方能力吧，
ui 也要改，适应其能力」（外部输入）。这是上一轮审查里标记为 **unclear**、我建议记待决的那一条
（Q3），产品负责人决定采纳。

**改法**：**不是**删掉那 6 条精选，而是让两条来源并存 —— 精选给「装上就能用、不用挑」的那几条
（产品意图，离线可用），目录给长尾（实时检索）。两处的 `group` 进同一张分组表，界面不为它们写第二套。

按 AGENTS.md §5.5 的顺序走完四层：

1. **端口**（`packages/engine`）：新增 `McpCatalogEntry` 值对象与 `McpPort.catalog(query)`。
   条目里带的不只是展示件，还有**能直接写盘的 `config`** 与**要人补什么的 `inputs`**
   （`required` / `sensitive` / `defaultValue`）—— 装上不等于能用，缺什么得随条目一起回来。
2. **engine-omp**：`searchSmitheryRegistry(keyword, { limit: 20 })`。**写进配置的名字经 omp 自己的
   `toConfigName` 归一**：目录名形如 `nexgendata-apify/github-mcp-server`，带斜杠，直接写盘会被
   `validateServerName` 拒（只许字母数字与 `_ . - :`）。
3. **testkit**：FakeEngine 的 `mcp.catalog` 按标题/说明做子串过滤（`FakeEngineOptions.mcpCatalog`
   注入式，默认空表）。
4. **契约**：新方法 `mcp.catalog`（`owner: core`，`timeoutMs: 30_000` —— 一次要取每条目的详情，
   别让 60 秒默认值掐了）；`PROTOCOL_VERSION` **17 → 18**，快照已重生成。

**UI 的适配（这次的重点）**：搜索框拆成两件事 —— **过滤已装**是逐字本地过滤，**去在线目录搜**要按
回车/点按钮（那是对外请求，跟着逐字发就是自己打自己）。目录卡片与精选同一套 DOM，动作区不同：

- 必填输入没填时**安装键点不动**，并写明缺哪个键；展开填上即可。
- 填的值**照抄 omp 的做法**落进 `--config`（`#applyRegistryInputOverrides`）：目录给的命令是
  `bunx @smithery/cli run <name> --config {}`，值就填在那个 `{}` 上。**远程条目（http/sse）不填** ——
  它的凭据走 OAuth / 请求头，目录也没给 `--config` 的位置，不假装填进去了。
- 重名按 omp 的规矩让开（`-2` / `-3`…）。
- 「取不到目录」与「没有结果」分开显示：前者是错误横幅，后者只是空列表。

**实测（真目录，不是读源码推的）**：`q=slack` 回 6 条，`verified` / `useCount` / `sourceType` 都对上；
一条 stdio 条目带出 `SLACK_BOT_TOKEN`（required + sensitive）；把 `slack` 真写进 mcp.json 再读回、
再删掉，`transport=http`、`enabled` 都如实。8 组关键词 34 条里，7 条有必填输入，**且全部是 stdio** ——
正好落在 `--config` 那条路径上，远程条目确实用不到。

**一致性与测试的取舍（重要）**：真实目录是第三方服务，**不让 `bun run all` 依赖它**。一致性子集只钉
离线的那一条（`C-MCP-CATALOG-EMPTY`：空关键词不发请求、返回空数组）；形状映射落在
`engine-omp/src/ports/__tests__/mcp.test.ts`，那里截住 `fetch` 喂一份按真实报文精简过的响应
（列表层带 `displayName` / `qualifiedName`，`configSchema` 挂在 **connection** 上，详情按
`namespace/slug` 取 —— 这三条都是实测踩出来的，写错了就会「检索命中 0 条」）。中途我曾把一致性用例
写成真连 registry，`C-MCP-CATALOG-SHAPE` 直接 5 秒超时 —— 那是给闸门装了一个外部开关，已改掉。

**验收**：`bun run all` 全绿（**2111 pass / 0 fail**，268 文件；较上轮 +22 条：契约 2 + 端口 3 +
UI 数据逻辑 11 + 卡片渲染 4 + 一致性 1 + 原有调整）。测试**不发网络**：端口用例截 `fetch`，
UI 用例喂固定条目。

**未做**：精选那 6 条**保持原样**（它们是产品意图，不是过时的硬编码）。Q44（MCP 四个死键与名称校验
错位）仍未动。

## R-13 复刻 DSH 的运行状态行与封条：什么时候出现、什么时候封、什么时候不封（2026-10-15）

**来源**：产品负责人交办的截图（对话页那条「深度求索中，用时 4秒 ···」）与口头要求 —— 全面复刻
DSH 桌面端这一处的**代码逻辑**，不是只照抄外观。参考物是本机安装版 DSH 的构建产物
（`@deepseek-ai/dsh-client-ui-chat@0.2.0-rc.2`，MIT），逐条抄录成规格后再落到本仓的层次上。

**参考物与它们的判据**（bundle 已反编译逐行核对，定位坐标记在本次侦察的规格文档里）：

| 参考物 | 管什么 |
| --- | --- |
| `RunningStatus` | 转录末尾那一行：`chat.deepDiving` / `chat.deepDivingFor`，1 秒一跳的本地时钟 |
| `RunningWhaleTail` | 鲸鱼尾图标：APNG 当 mask 着色，静态 SVG 兜底 |
| `TurnProcessNodeView` | 封条的渲染与三档文案；**`turn.status !== 'closed'` 直接返回 null** |
| `turnProcessAlwaysOpen` | 「永远摊开」：`status === 'open'` 或 `reason` 是 aborted / error |
| `derivePresentation` 的 `hasInterleavedInput` | 「中途有人插过话」同样是永远摊开（`alwaysOpen = liveProcess \|\| hasInterleavedInput \|\| turnProcessAlwaysOpen`） |
| `processSpec` + `derivePresentation` | `foldable` / `hasContent` / `open` 三格怎么解出来 |

**复刻到本仓的映射**（DSH 的概念 → 本仓已有的那一格）：

1. **轮的终局**：DSH 读 `turn.end.reason.kind`；本仓对应 omp 的 `TranscriptTurn['state']`
   （`completed` / `cancelled` / `failed`）。新增 `TurnOutcome = 'completed' | 'aborted' | 'error'`，
   由 `transcript-projector` 的 `outcomeOf()` 映射后挂到 `TurnPage.outcome` 上。**`cancelled` → aborted
   （「已停止」）、`failed` → error（「处理失败」）**：一个是人叫停的，一个是它自己坏的。
2. **什么时候出现**：DSH 的判据是**这一轮已经在跑**（`running && <RunningStatus>`）。本仓上屏判据
   同一条 —— `Presentation.running` 只在 `active.run.settled === false` 时给出。
3. **什么时候封**：DSH 的封条只在轮**结束之后**存在（`turn.status !== 'closed' → null`）。本仓的
   `sealOf()` 因此加一条 `|| running → undefined`：**在跑的那一轮没有封条**，那一句由末尾的运行
   状态行说。这不是删功能 —— 两处都报「正在处理」本来就是两种说法说同一件事。
4. **什么时候选择不封**（DSH `turnProcessAlwaysOpen` + `hasInterleavedInput`）：**被人叫停、
   自己坏了、中途有人插过话**，三者都**不接受折叠** —— 前两个要让人看见它停在哪、坏在哪；
   第三个是因为那段过程里夹着人自己的话（气泡就落在过程那一段里），折起来会把他的话一起藏掉。
   正常答完的才谈得上折，且默认收起。DSH 的 `status === 'open'`（正在跑）那一档在本仓由上一条
   吸收 —— 在跑的轮压根没有封条。
   插话的判据是**端到端**的：`interjectedIn()` 只认「人说的话出现在它的产出之后」。这正好对上
   引擎的真实形态 —— `live.ts` 里开场那条用户帧**不带 origin**（不上屏），只有 `steeredFrame`
   才给 `origin: { kind: 'user' }`，而带 origin 的才在投影里成行（`sourceOfFrame` 只认它）。
   所以「产出之后出现的人话」与「真的插过话」是同一件事，不是近似。
5. **封条的三档文案**（DSH `TurnProcessNodeView`）：`已停止` / `处理失败` / `已完成`；
   正常答完才带时长（`已完成，用时 N`），**被打断与出错不报时长**，且时长下限 1 秒
   （`Math.max(1e3, …)`）—— 屏幕上不出现「0秒」。
6. **用时的格式**（DSH `formatRunDuration`）：整秒向下取整，**秒永远在场**，60 秒起才带分、
   1 小时起才带小时（`1分0秒` / `1小时0分0秒`）。与仓里原有的 `formatDuration`（`<1秒` 起、
   进位制紧凑式）是两种口径，所以**新增 `formatRunDuration` 而不是改旧的** —— 旧的那一支还给
   别处用着。

**偏差（与 DSH 不一致或本仓另有做法的地方，逐条说明）**：

- **气泡里那三个点是 U+00B7 MIDDLE DOT，不是省略号**（DSH 的 `chat.deepDivingFor` 原文
  `"深度求索中，用时 {duration} ···"`，码点 U+00B7 ×3）。照抄：省略号读起来是「这里被截断了」，
  它说的是「还在往外冒」。测试钉住码点。
- **没有做 DSH 的 `stepGrouping` / `transcript detail` 四档策略**（简洁 / 标准 / 详细 / 完全展开）。
  本仓没有「工作步骤展示」这个设置项，过程的折叠规则是单一的。要求里没有它，为一个参考物加的
  设置项属于超范围。
- **运行状态行挂在转录盒内、末尾留白的上沿**（绝对定位，纵向位移 = 虚拟器 `total - paddingEnd`），
  DSH 是 flex 列的最后一项。抄的是**行为**（常驻、不参与行测量、被内容推着走）：本仓的行由虚拟器
  绝对定位，直接塞一个 flex 子项会被算进 `measureElement`，那一格每秒改字就是每秒一次滚动补偿。
- **秒针走本仓的 `useSecond`（`primitives/clock.ts`）**，不用 DSH 的 `setInterval(1s)`：那一口钟
  已经做了「没人在看就不烧 CPU」「窗口重新可见先补一帧」，且期限归消费者报。
- **扫光沿用本仓的 `.timeline-shimmer`**（`background-clip: text` + 横移渐变），只把颜色抽成
  `--cp-shimmer-base` / `--cp-shimmer-sweep` 两个变量给运行行换成它那一对蓝。没有照抄 DSH 的
  TextShimmer（那是「真实内容层 + aria-hidden 装饰层 + 反向 translateX」的另一套实现）——
  本仓已有等价物，再引入一套是两套做法说同一件事。
- **鲸鱼图标资产取 DSH 的 APNG**（28×28、60 帧、3 秒循环），静态那条是 DSH 的 `REST_PATH`
  描边路径。切换条件照抄它的三条 AND：`@supports (mask-mode: alpha) and (mask-image: url(""))` ×
  `prefers-reduced-motion: no-preference` × `forced-colors: none`。
- **封条那枚箭头的旋转方向沿用本仓**：本仓一律 `-90deg → 0deg`（`disclosure.css` 与
  `turn-seal.css` 都是这套），DSH 是 `0deg → 180deg`。这一处**在本次改动之前就是本仓的样子**
  （`git show origin/main:…turn-seal.css` 可见），改它等于顺手改掉全仓的箭头语言，
  超出这次复刻的范围，所以留着并在此记明。

**测试**（新增 59 条，全部先写、按新判据红过再实现）：

- `duration.test.ts`（10）：整秒向下取整、60 秒才带分、1 小时才带小时、秒永远在场、
  **非有限值当 0**（NaN 会一路印成「NaN秒」，实测抓到）；外加数字 / 单位分格的形状四条
  （只有数字那一格戴等宽字，且「逐格渲染」与「拼成一个串」两条路径等价）。
- `running-status.test.tsx`（6）：文案两态、**结尾是三个 U+00B7 且不含 U+2026**、
  分隔线只在上面有产出时画、鲸鱼两层都在且都 `aria-hidden`、live 区只播那句固定文案。
- `turn-seal.test.tsx`（12）：三档文案、打断与出错不报时长、1 秒下限、
  `durationMs` 优先于两头相减（那两个时刻只覆盖最后一跳）、老载荷缺终局不编「失败」、
  能折才是按钮且带 `aria-expanded`。
- `turn-seal-plan.test.ts`（20）：**「什么时候不封」的四条**（在跑没有封条、被打断不折、
  出错不折、**插过话不折**）、不存在运行事实就没有封条、没有过程可折就不画开关、
  **封条挂在这一轮的第一行上**（收起之后行号不漂）、折起来时过程真的离开投影、
  运行状态行的四条判据（在跑才有、起始时刻来自段、分隔线的四种来路）。
- `transcript-projector-outcome.test.ts`（8）：**端到端** —— omp 的 `state` → `TurnPage.outcome`
  四档各一条、终局封口之后仍留在那一页上；外加插话那三条走**真实投影**：插过话的轮不折、
  没插过的照常可折、插话在投影里确实是一条排在产出之后的 `user_message`。

**对着参考物复核时补上的四处**（都不是测试抓的，是把两边的 CSS 摆在一起逐条比出来的）：

1. **`hasInterleavedInput` 这一档漏了**：DSH 的 `alwaysOpen` 有三个分支
   （`liveProcess || hasInterleavedInput || turnProcessAlwaysOpen`），最初只搬了两档。
   插过话的那一轮在屏幕上就是一条落在过程**中间**的用户气泡，折起来会把人自己的话一起藏掉。
2. **用时的数字没有换等宽字**：DSH 把 `formatRunDuration` 的产物**按 part 分格渲染**，
   只给 `numeric` 的那一格戴 `--ds-font-family-code` + `tabular-nums`。原先合成一个字符串，
   秒数每秒在变、比例字会让那半句左右抽动。现在 `formatRunDuration` 交回 parts，
   运行行与封条各按 part 出格子（真 Chromium 复核：数字解析出 Consolas + tabular-nums，
   汉字仍是正文那一支）。
3. **运行行的字号大了一号**：DSH 写的是 `calc(var(--dsh-content-font-size, 14px) - 2px)`，
   即**正文减 2px = 12px**；本仓原先取 `--cp-font-caption`（`--cp-font(16px) - 3px` = 13px）。
   把 DSH 那条式子按本仓的正文刻度（`--ui-prose-size` = 14px）重新解一遍，落在
   `--ui-prose-size-meta`（0.75rem = 12px）上，正好是同一档。真 Chromium 复核：改前 13px、改后 12px。
   顺带把 `tabular-nums` 从容器挪到那句可见文案上（DSH 的 `runningText` 就是这么戴的）。
4. **鲸鱼图标大了一号**：DSH 的 `runningIcon` 边长是 `calc(14px + font-delta)`，**就是正文刻度**
   （content-font-size = 14px）；本仓原先读 `--cp-icon`（`--ui-icon-size-sm` = 16px），
   那是工具行的图标档，挂在状态行上会压过那句话。改成 `--ui-prose-size`，
   真 Chromium 复核：图标盒 14×14（改前 16×16）。

**过程中被测试抓到的两个真缺陷**（都在这轮里改掉）：

1. **分隔线为运行锚点也画了一根**：`run_anchor` 是承载封条用的合成条目、自己不上屏，
   拿它当「上面有产出」等于凭空多一道线。判据补上 `item.type !== 'run_anchor'`。
2. **`formatRunDuration(NaN)` 印出「NaN秒」**：非有限值先归 0。

**验收**：`bun run typecheck` 干净（752 files / 80 projects + 977 test files）；
`bun run lint` **全绿**（那 6 处既有失败已单独成一笔 `chore(lint)` 修掉，见下）；
`bun test` **2167 pass / 0 fail**（273 文件）；`bun run desktop:build` 通过，鲸鱼 PNG 落在
`out/renderer/assets/whale-tail-*.png`、CSS 里的 `url()` 指向它，且规则落在**入口那两张
样式表**里（不是按需分块 —— 已核对 `index.html` 直链的那两张）。
`bun run check:ticker`：`steady` / `batched` / `slow` / `fast` 全过，
**两条核心指标（右裁、句首被裁）全部场景 0**；`resize` 的平滑度 `sJ90` 判红 —— 该场景在
**改动前**（`shimmer.css` 原样 stash 后连跑三次）同样是 0.26 / 0.27 / 0.28，是本机既有基线，
不是这次改出来的。

**偏差（工具链环境，不是代码）**：本会话里 `ELECTRON_RUN_AS_NODE=1`，直接 `bun run check:ticker`
会让 electron 以纯 Node 启动、`require('electron')` 交出 undefined 而报
`Cannot read properties of undefined (reading 'whenReady')`。跑之前清掉这个变量即可
（`$env:ELECTRON_RUN_AS_NODE = $null`）。这条不影响 CI。

**另记（与复刻无关的一笔）**：`main@bba994e2` 上 `bun run lint` 本来就是红的
（6 errors / 4 warnings，工作区干净时即可复现），全部落在本次改动之外。按「`bun run all`
不绿不提交」单独成一笔 `chore(lint)`：`session-controls.css` / `review-pane.tsx` /
`dropdown-menu.tsx` / `popup-surface.ts` / `design-system/src/index.ts` 的格式化，
以及 `pr-detail.tsx` 一个未用导入。只有格式化与删导入，无行为变化。

**待决问题**：无。

---

## R-13 补修：进程中途没了的那一轮报「已停止」，不报「已完成」（2026-10-15）

**来源**：R-13 合并之后，拿 DSH 的**真源码**（不是安装版的压缩产物）逐条复核时发现的一处漏网。

**上游真源码怎么说的**。DSH 那边「轮怎么结束的」有四种 reason，其中 `interrupted` 是
**进程在轮跑完之前就退出了**（`packages/client/ui-chat/src/client/conversation-nodes/turn-error.ts`：
`case 'interrupted': return { message: 'The DSH process exited before this turn finished.', code: 'INTERRUPTED' }`）。
它在两处都算「停」：

- `contract/turn-process.ts`：`status === 'open' || reason === 'aborted' || reason === 'interrupted' || reason === 'error'`
  → 永不折叠；
- `chat/TurnProcessNodeView.tsx`：`const stopped = reason === 'aborted' || reason === 'interrupted'`
  → 报「已停止」，且不报时长。

**本仓的对应物**：本机把还在跑的那一轮收掉走 `transcript-store` 的 `settleActiveRun`（Core 崩溃、
被关掉时不再有帧）。它原先**只写 `run.settled`、不写终局**，于是封条落到「缺终局按正常答完算」
那一支 —— **屏幕把死在半路的一轮报成「已完成」，还让它可折**。实测：`{canCollapse: true, isOpen: false}`。

**改法**：`settleActiveRun` 同时写终局。分两种收尾，因为语义不同：

| 情形 | `degraded` | 终局 | 屏幕 |
| --- | --- | --- | --- |
| 真的死在半路 | `false` | `aborted` | 「已停止」，摊开、不可折（= DSH 的 `interrupted`） |
| 跑完了只是掉了帧 | `true` | 不写 | 「已完成」本来就是对的，不该改口 |

`#runFailed` 因此从「编号」改成「编号 + `degraded`」。另外只在**缺那一格**时补：
agent 自己报过终局的（`completed` / `cancelled` / `failed`）一律不改口。

**测试**（6 条，全部先在旧代码上红过）。红的样子正是缺陷本身：`outcome === undefined`、
封条 `canCollapse: true, isOpen: false`。

- 收掉时写下 `aborted`（`status: failed` + `run.settled`）。
- 收掉之后封条摊开且不可折。
- `degraded` 那一轮照旧「已完成」。
- 在跑（有 `run`、无 `outcome`）被收掉 → 补 `aborted`。
- agent 报过 `completed` 之后本机再收 → 仍是 `completed`。
- 写下的终局**活得过下一次投影**（`timeline` 每次由快照整块重算，只贴一次会被冲掉）。

**验收**：`bun run all` 全绿（**2172 pass / 0 fail**，273 文件，较 R-13 合并时的 2167 多 5 条）；
真 Chromium 复核封条多出的一档报「已停止」且不带时长。

**另记（R-13 的复核手段）**：R-13 当时只有本机安装版的压缩产物，靠反编译逐行抄。
`web_fetch` 连不上 GitHub 就误判成「没网」，实际是 **git 配了代理 `127.0.0.1:7897` 而 `web_fetch` 不走它** ——
清掉这个误区后 `git clone` 到了真源码（`packages/client/ui-chat/src/`），逐条对完的结论：

- **逐字一致的**：鲸鱼 PNG 字节相同（同 sha256）、`REST_PATH`、那三个点是 **U+00B7 ×3** 不是省略号、
  单位 `秒`/`分`/`小时`、`formatRunDuration` 的边界、`durationNumber` 的等宽字、
  CSS 的 `margin:8px 0 10px` 与字号 / 图标公式。
- **源码里有、但已装版没有的**：`interrupted` 这一档 reason 是 `0.2.1-alpha.3` 才加的，已装版
  `rc.2` 的编译产物里 `turnProcessAlwaysOpen` 只有三个分支。复刻对齐的是**用户机器上装的那个版本**，
  所以 R-13 当时没抄错；上面这一条补修针对的是**本仓自己**那条 DSH 没有的收尾路径。

**待决问题**：无。

## R-19 四个启动 / 附件现象：气泡丢图、深色闪白、侧栏跳变、恢复后控件不画

**来源**：核心工程师交办的四个现象（外部输入，不入库）。每一条先写会红的用例，再改。

1. **R-19-1 用户气泡上的图**（三条根因，同一个现象）：
   - 历史投影 `projector/history.ts` 只发 `attachment.upsert`、**轮头不挂 attachmentIds**；UI 只按轮头的号找图 →
     任何一次快照 / 整页重读（timeline.subscribe、reset、重启）图都消失。`turnOp(entry, attachmentIds)` 补上。
   - 会话忙时 Core 把 turn 降级成 followUp / 插话：`enqueue` 不保留图、认领时 `steeredFrame(text)` 不带图 →
     模型看得见、气泡上没有。`QueueEntry.images`（只读一次盘），`steeredFrame(text, images)` 先发条目、帧上挂号；
     `queue()` 改为逐字段拷贝（不把 data URL 推进每一次队列通知）。
   - 一轮还开着时取快照：历史铸的号与 live 的不同，`turnEnd` 再发一次轮头就把图换没了。
     `HistoryPageOptions.openTurnAttachments`：开着的那一轮沿用 live 的条目。
   - UI `transcript-projector.ts`：人话帧也渲染附件；附件索引只要有条目就建；按轮缓存的命中条件加上「引用的条目没变」。
2. **R-19-2 深色启动闪白**：`index.html` 写死 `data-theme="light"`，第一帧（ready-to-show）只有底衬那一层且是白的。
   去掉写死的属性；`styles.css` 在 `:root:not([data-theme])` 上按 `prefers-color-scheme` 兜底衬（Host 在建窗前已设
   `nativeTheme.themeSource`，这个媒体查询就是解析后的那一档）；preferences UI 在 setup 里同步投一次主题；
   platform 的 beforeWindow 不再写浅色 `backgroundColor`（configureMain 后写覆盖，结果取决于模块顺序）。
3. **R-19-3 侧栏启动跳变**：布局本来就有记忆（uiState `layout`），但只在 onCoreReady 里恢复 —— 要等 Core。
   改为 setup 里立即恢复（请求先于 `core.getStatus` 发出、按序应答，落在第一次渲染之前）；恢复完成后即开始写回，
   不再等 Core。路由恢复仍在 onCoreReady（目标表面要向 Core 要数据）。
4. **R-19-4 恢复到线程后输入框控件不画**：只有点侧栏的 `actions.openThread` 会 `controls.refresh`；
   `navigation.restore` 进来的线程表面只调 `threads.open`，又与 Core 就绪时的 `resyncVisible` 竞态。
   线程表面改用 `createThreadSurfaceOpener`（预热 + 拉控件表）；`controls-store.refresh` 按对话号合并在途请求，
   且 refresh 发出后又收到 `controls.changed` 推送时不拿旧应答覆盖。

**契约**：没有变化（`QueueItem` 仍是 4 个字段，`attachmentIds` 本就是轮头 / 帧的可选字段），`PROTOCOL_VERSION` 不动。

## R-20 两个现象：「提交未完成；请先核对会话。」横幅误报、内置浏览器 / eval 报 same-realm（基于 d18d9fc）

**来源**：核心工程师交办的两个现象（外部输入，不入库）。

1. **R-20-1「提交未完成；请先核对会话。」+「取回文字」凭空出现**（截图里 notice 为空 → 横幅来自 Core 的提交行）：
   - **`queued` 从来没有终局**：`SubmissionService.deliver` 忙时把 turn 降级成 followUp（或本来就是插话 / 排队）后记成
     `queued`，之后 omp 取走 / 人撤回 / omp 丢弃都没人改它。下次 Core 启动 `recoverOnStart → failUndelivered` 把**全部
     历史 queued 行**（早已送达、早已答复）改成 failed / `core_restarted`。「连发两次」正是第二句进了 followUp。
   - **整读后「最后一条」变了**：`viewOfThread` 剔除已在页内的 started 行，旧的 failed 行成了列表末尾 →
     每次重启 / 重开对话都复活横幅；`withSubmissionRows` 还把它当未送达气泡插到当前轮开头。
   - 附带：UI 本机提交（`accepted`，promptId = clientTurnId）在 followUp 送达时没有任何 turn 带这个号，永不收口；
     `emitRemoved` 有依赖却从未被调用（`discard` 也不发）。

   改法：引擎 `SubmitInput.ref` + 会话事件 `queueSettled { ref, outcome: delivered | withdrawn | dropped }`
   （`OmpSession`：对账搬进 consumed / message_start 先到 / 撤回时 omp 已取走 → delivered；撤回 → withdrawn，换层
   `moveQueued` 不报；`promptDropped` 对上账本项 → 摘掉并 dropped）。Core `deliver` 带 `ref: clientTurnId`，
   `settleQueued`：送达 / 撤回删行并推 `submissions.removed`，丢弃收成 failed(`submit_dropped`)，幂等；只在仍为
   pending 时才记 `queued`（结局可能先到）。`submit` 插入新行时同线程更早的 failed 行到此为止（删行并推 removed，
   与 UI `send()` 同一条规矩）；`discard` 补推 removed。迁移 v3 `submissions_cleanup` 一次性删掉升级前的 `queued` 行、
   `core_restarted` 失败行、以及被更晚非失败提交取代的失败行。UI：`removeSubmission` 一并收掉本机同号提交；
   `readFailedSubmissionText` 按 `createdAt` 取最晚一行。`FakeEngine` 撤回时同样报 `queueSettled`。
2. **R-20-2 AI 用不了内置浏览器 / eval 报「Cannot run code while another same-realm JS runtime is running」**：
   omp 的 `cli.ts` 被 import 时**自己会派发**（`isProcessEntry = import.meta.main || process.env.PI_COMPILED === "true"`，
   `if (isProcessEntry || !Bun.isMainThread) runCli(process.argv.slice(2))`），`process-mode.ts` 又 `runCli([selector])` 一次。
   编译版（build define 了 PI_COMPILED）每个 worker 子进程、以及任何 worker 线程里，omp 的 worker 入口都起了两份：
   eval 子进程两个 JsRuntime 同吃一条 run → 第二个立刻报 same-realm，宿主先收到这个错误结果；broker 子进程两个
   broker 抢同一根命名管道；browser-relay 同样双启动。次要：worker 线程里 Poietica 先装的收件箱被 omp 自派发时装的
   第二个覆盖，父线程同步发的 init 握手进了孤儿缓存 → 等满 init 超时后退回 inline tab worker（跑在 Core realm 里）。

   改法：新文件 `bootstrap/worker-dispatch.ts`（无副作用）：`ompCliSelfDispatches()`（编译版或 worker 线程 → cli 自派发）
   与 `holdEarlyMessages(port)`（同步前缀里接住早到消息，第一个 `on('message')` 注册时按序回放并换回原 `on`；30 s
   无人接则放手清空）。`process-mode.ts`：worker / relay 分支只在 cli 不自派发时 runCli；worker 线程用
   `holdEarlyMessages` 代替 `installWorkerInbox`。omp 知识 #1 改写；钉子测试读 omp `cli.ts` 源码断言自派发条件。
   Python「backend unavailable」是机器上没装 Python kernel，不是缺陷。

**契约**：`SubmitInput.ref` 与 `queueSettled` 是引擎内部 TS 接口（engine ↔ engine-omp ↔ conversation core），
RPC 契约与 `PROTOCOL_VERSION` 不变；conversation 新增迁移 v3（只删行，不改表结构）。

## R-21 压缩上下文：前文消失、卡在「正在压缩上下文…」、压缩行与工具行两种长相（基于 f4bbe0f）

**来源**：核心工程师交办的三个现象（外部输入，不入库）：压缩之后前面的对话莫名消失；一直停在「正在压缩上下文…」；
压缩那一行（`↻` + 灰字）与工具调用行长得不一样。

1. **R-21-1 前文消失**：历史分页（`page`）与落座（`seat`）读的是 `session.messages` —— 那是 omp 的**模型上下文**，
   压缩之后只剩「摘要 + 保留的尾巴」。适配器又在 `auto_compaction_end` 时 `timelineReset`，UI 整页重取，
   拿到的就是这份残缺的经过；`screenTurns` 还把摘要当成开轮消息，轮号从 1 重数（与增量那条路的 `turnOrdinal` 错位，
   重开会话后下一句话会盖掉已有的轮），压缩之后同一轮的段被吞进一格只画 marker 的「压缩轮」。
   改法：分页与落座改读 omp 的**显示经过** `buildTranscriptSessionContext({ collapseCompactedHistory: false,
   keepDanglingToolCalls: 开着轮 })`（omp 知识 #19；TUI 重画对话用的同一个入口）——前文都在，每次压缩在发生处留一条
   `compactionSummary`。历史投影里压缩**不开轮**，挂在当时开着的那一轮后面（`compaction-<轮>-<次>`；第一句人话之前的
   归第 0 轮、只跟最早那一页走）；封了口的轮里没有结果的工具调用由投影自己剥（与 omp 同口径，开着的那一轮保留）。
   UI 投影 `placeCompactions`：压缩行落进条目序里它前面那一轮的页、页内按时刻插位（中途压缩之后的段在它下面），
   不再一律挤到活动段尾部；按基础页身份记账，sealed 页引用稳定。
2. **R-21-2 卡在「正在压缩上下文…」**：收口时先 upsert completed、紧接着 `timelineReset`——重置丢掉了还没发出去的
   那一帧，重取的历史又按「最新一轮还开着」把摘要轮标成 running（中途 / overflow 压缩时轮一定开着），之后再没有
   任何事件改它。改法：收口**不再整页重取**（屏幕上的东西都是增量那条路画的，压缩不改写它们）；落了盘的压缩恒为
   completed；增量那条路的号改由 `LiveProjector.compactionStart/compactionEnd` 铸（`compaction-live-<n>`，同一轮压两次
   不互相覆盖，与历史的号分属两个名字空间）。关门载荷统一走 `projector/compaction.ts`：aborted → cancelled（带 error）、
   有 result → completed（token 数 / 摘要以 omp 刚落盘的那条摘要为准，`tokensAfter` 只在条目上，omp 知识 #20）、
   只有 errorMessage → **failed**（新状态）、skipped → `items.remove` 撤掉那一格、shake 就地改写 → completed；
   收口后重报一次上下文占用。
3. **R-21-3 样式**：`CompactionStatus` 改成工具行同一套结构：`.timeline-tool > .timeline-row`（`FoldVertical` 字形 +
   一句话 + 悬停箭头），跑着时那句话走 `timeline-shimmer`；有摘要 / 原因 / 告警时可展开，抽屉是同一个
   `.timeline-tool__panel` + Prose。文案：「正在压缩上下文…」「已压缩上下文 · a → b tokens」「上下文压缩已取消 / 失败」。
   删除 `compaction-status.css`。`CompactionTimelineItem` 增 `summary / error / warning / superseded`，`CompactionState` 增 `failed`。

**契约**：transcript 的 op / marker 形状不变（payload 多几个可选字段）；RPC 契约与 `PROTOCOL_VERSION` 不变。

**测试**：engine-omp `projector/__tests__/compaction.test.ts`（关门载荷四档、跳过撤格、同轮两次两行、不再 reset、
分页读显示经过、omp 源码钉子）、`history.test.ts`（前文与轮号、中途压缩的段归原轮、开着轮时仍 completed、superseded、
同轮两次、首页才带第 0 轮的压缩、悬挂调用）、`history-legacy.test.ts` 改成新号；conversation
`transcript-projector-compaction.test.ts`（落页 / 页内插位 / 载荷 / 页对象复用 / 无轮）、`compaction-status.test.tsx`。

## R-22 minimap：鼠标移出时闪现「未命名轮次」（基于 d8e26a3）

**现象**：悬浮时预览正常，鼠标移出的一瞬间，卡片稳定闪成「未命名轮次 / 暂无文本回复」。

**根因**：`useRailPointer` 离开命中区后报告 `-1`，`marks[shown]` 随即变成 `undefined`。
旧渲染在撤掉 `data-shown` 的同一次提交中，把正文换成空轮次占位；但 CSS 还有 60ms 退出延迟和
140ms 淡出，正文替换立刻可见。不是轮次数据丢失，也不是命中范围抖动。

**改法**：在同文件内拆出 `PreviewCard`，将显示条件与内容寿命分开。是否显示仍取决于当前 `mark`；
内容保留最后一个有效 `TurnMark` 快照（不是下标）。退场只撤显示标记，不清正文；快速重入、跨轮或流式更新
立即使用新内容；从未命中时不渲染假轮次。真实空标题 / 空回复的占位照旧。无新增定时器，不改 CSS、
命中范围、动画节奏或协议；每个卡片只保留一个快照，随组件卸载释放。

**测试**：`minimap/__tests__/conversation-minimap.test.tsx` 新增 10 个用例，走真实指针 hook，覆盖初次挂载、
退出、快速重入、流式更新、退出后列表重排、当前轮移除、真实空内容、pointerleave / 窗口 blur 与键盘焦点退出。
本地 Chromium 加载真实组件和 CSS，在浅 / 深色、1 / 1.25 DPR 下分别重复 5 次，逐帧确认退出期间不再出现占位文案，
同时保留原有淡出；快速重入、键盘退出及减弱动效也通过。Windows Electron 真机验收仍由维护者执行。
