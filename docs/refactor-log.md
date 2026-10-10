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
