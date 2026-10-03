# 0026 — 插话走 agent 自己的三层队列，本机不留第二份出账簿

## 状态

已接受，**决策 4 由 ADR 0034 取代**（aside 整档不接，见该文；本文编号与其余决策不改
—— ADR 一改号就断了引用）。取代本仓此前那条"本机出账簿"的做法
（`packages/conversation/src/interjection/interjection-outbox.ts`，含它的
`queue`/`holding`/`release` 状态机），以及线上那条把 **prompt 号当正文**发进插话队列的
`steer` 命令。

## 背景

"流式中发消息"此前是这样接的：本机排一个 `InterjectionOutbox`，等这一轮的
`turn_end` 到达才把它们依次交出去。三处硬伤，都能指到具体代码：

1. **档位从来没用上。** 线上唯一的插话命令是
   `agent_steer { threadId, promptIds }`，Rust 侧 `prompt_ids.join("\n")` 之后原样投给
   桥。也就是说传过去的是**账本里的 prompt 号**，不是那句话 —— 进队列的是
   `"3f2a-..."` 这样的字符串。上游 `AgentSession.steer` 收的是正文。
   三层里一层都没真的用上（steer / followUp / aside 在 protocol 里根本不存在）。

2. **流式中发送会撞 `AgentBusyError` 并把那一轮记成失败。** `sendPrompt` 无条件调
   `agent.prompt(text)`；上游在流式中不带 `streamingBehavior` 时抛
   （`agent-session.ts:6467`）。本机于是补一条"这一轮没起来"的失败轮终，而用户的
   那句话既没排上队也没进上下文。

3. **队列排了个第二份。** 出账簿自己记住"排着哪些话、谁在 hold"，而 agent 的
   `#steeringQueue` / `#followUpQueue` 也在记。两份状态一让步调就不一致（屏幕上
   排着、agent 那边没有；或反过来），违反"每一类状态有且只有一个所有者"。

omp 18.3.0 的真实契约（以下均为包内源码，非文档传闻；锚点见文末）：

- `AgentSession.steer(text, images?, options?)`（`agent-session.ts:7248`）——
  插进正在跑的那一轮，工具批次之间被模型看到。
- `AgentSession.followUp(text, images?, options?)`（`:7270`）—— 不打断，
  这一轮跑完接着做。
- `AgentSession.sendUserMessage(content, { deliverAs })`（`:7850`）——
  `deliverAs: "aside"` 时**流式中**进旁路队列、在 step 边界注入，绝不打断在跑的工具批；
  空闲时上游自己退成开一轮（"there is no live run to inject an aside into"）。
  省略 `deliverAs` 是"空闲开轮、流式中 steer"。
- 两个队列的读法与写法：`getQueuedMessages(): {steering, followUp}`
  （`:7946`，只回正文）、`popLastQueuedMessage(): RestoredQueuedMessage | undefined`
  （`:7958`，**LIFO**，还会连带取走紧挨其前的隐藏伴生消息）、
  `setSteeringMode / setFollowUpMode / setInterruptMode`（`:8814/:8826/:8838`，
  默认 `persist = true`，落 agent 自己的 config.yml）。
- 队列**没有变更事件**。上游只在 `getQueuedMessages` 里报此刻的样子。
- `setPromptDropped(handler)`（`:8335`）—— 这一句在**入队之前**就被取消了
  （abort 或用量预检抢走这一轮，`:6590`/`:6605`）。它**没有落进会话文件**，
  transcript 里永远不会有它。
- 插话落地只有一条上游事件：注入消息被折进上下文时发 `message_start` / `message_end`
  （`pi-agent-core` 的 `agent-loop.ts:1092` 的 `emitInputMessages`，由 `:1165`/`:1176`
  等处在每个 iteration 的注入点调用）。**开场那句 prompt 也走同一对事件。**

## 决策

1. ~~**三层插话就是线上的 `deliverAs` 四档，正文是那一句话本身。**~~
   **四档现为三档（ADR 0034 删掉 `aside`）：** `prompt` 命令带
   `deliverAs: "turn" | "steer" | "followUp"`（必填），
   桥按档分派到上面三个 upstream 方法。把 prompt **号**当正文那条路彻底删掉
   （`agent_steer` 命令不再存在）。四档的字面量在 `wire.rs` 里有逐字的回归测试：
   对不上时桥会把 `deliverAs` 读成 `undefined`，而它是必填，整条命令会被静默丢掉。

2. **队列归 agent，本机不留副本。** 删掉 `InterjectionOutbox`。本机只保留
   "把它报来的快照按对话存一份供屏幕订阅"（`MessageQueue`）与三个写动作的转发：
   - 读：`queue` 命令 → `getQueuedMessages` + 三个模式；
   - 撤：`withdraw` 命令 → `popLastQueuedMessage`（**LIFO**，所以屏幕上只有最后
     一句带撤回键 —— 给按不动的键比不给键更坏）；
   - 改模式：`delivery` 命令 → `setSteeringMode/...`，**缺席的格不改**
     （所以 wire 上不能写 `null`，写 `null` 会被读成一次改）。

   队列快照带 `sessionId`：队列是**会话级**的事实而屏幕按对话订阅，认领需要这个号
   （bridge 的 `record.id`）。认不出的会话不认领 —— 猜一个归属就是把 chip 画到别人的
   对话上。推送点由桥自己认（投递、撤回、改模式、轮终、取消、以及注入消息的
   `message_start`），conversation 层在刚绑上会话时另读一次补缺口。

3. **流式中回车 = steer，Ctrl/⌘+Enter = followUp。** 判据在
   `useAssistantSession.send`：`deliverAs` 缺省时取"这一刻这一格是不是在飞"
   （`canCancel`，含"回执还没回来"那一档 —— 拿不准时插话不丢话，上游对插话永远不抛
   忙碌错）；点名了就用点名的。沿用了 omp 自己 TUI 的手势（`input-controller.ts`
   的空闲路径也带 `streamingBehavior: "steer"`），所以退出那一刻不会因为撞
   `AgentBusyError` 把那句话吞掉。桥里另有一处兜底：真撞上 `AgentBusyError`（界面
   看着空闲但事件还没到）就明着补一次 steer 并如实把那一轮收成失败 —— 话不丢，
   账也不假。

4. ~~**`aside` 不做本机入口，但留完整的投递面。** 它没有 UI 手势（omp 的 TUI 也没有），
   投递路径与图片支持仍然完整，谁要用谁点名 `deliverAs: "aside"`。它不进
   `getQueuedMessages` 那两个队列（走 IRC 那条旁路，`queuedMessageCount` 也不算它），
   所以队列快照里没有它的位置 —— 编一格假的只会让屏幕说一句 agent 没说过的话。~~
   **已由 ADR 0034 取代：** 它加了本机手势之后两版都错 —— 不报它，那一行按下去就凭空
   消失、过一会儿又从 transcript 冒出来；一直报它，认领之前它永远在、屏幕上一行永不消失。
   根因是**上游不报 aside 的生死**（它不进 `getQueuedMessages`，也没有按条读它的 API），
   所以这一档整档不接了。

5. **插话画在哪一格由投影器判，不由这一层猜。** 注入消息的 `message_start` 到了以后，
   桥按**正文**认领自己投出去还没露面的那一条（开场白也走同一对事件，所以判据必须是
   "这条正文是不是我投的"），然后交给 `TranscriptProjector.steeredFrame`：
   开着一轮就是**这一轮里的一句**（模型在工具批次之间看见它，接着干同一轮的活），
   没开着一轮（followUp 在轮终之后被排成下一轮）就是这句话自己开一轮。
   认不出来的一律不动 —— 宁可少画一条，也不把开场白错画成插话。

6. **入队前被取消的那一句必须收账。** `setPromptDropped` 是它唯一的出口：
   没有 transcript 帧会来解释它。conversation 层按正文找回那条还在提交中的乐观记录，
   收成失败并说清楚"没有落进会话"—— 否则屏幕上那条记录永远挂着，发送键一直转。

7. **abort 不排空队列。** 上游外部 abort 刻意不 drain steering 队列
   （`agent-loop.ts:1637-1643`，留给 post-abort 的 continue 消费），所以本机也不替
   用户删任何一句：取消之后 chip 仍在，正是它该有的样子。桥只在这一刻把队列的新样子
   推一次。

8. **准入冻结投递档。** `deliverAs` 是本机账本必须记住的事实（哪句话是怎么进去的），
   所以进 `Admission` 的 `deliver_as` 一格（形状见 `crates/ledger/src/schema.sql`）。
   Rust 侧 `PromptDelivery` 与 `Submission` 都带它，TS 侧同名。

## 后果

- "流式中发消息"从"排在本机、等轮终、再当新轮发"变成"**真的插进正在跑的那一轮**"，
  这是 omp 自己的语义，也是用户按下去时预期的那个意思。
- 屏幕上多了一条队列条（两层分栏：steering 是"下一批工具跑完就看见"，followUp 是
  "这一轮跑完接着做"），每一句只有一个来源：agent。
- 队列模式（`steeringMode` / `followUpMode` / `interruptMode`）**改在 agent 自己的
  config.yml 里**（上游默认 `persist = true`）。本机的设置界面若要暴露它们，读的写的
  都是 agent 那一份，不再另立一格；目前只做了线上与领域层的通路，UI 未接（见"缺口"）。
- aside 的图片会与正文一起进队列（`sendUserMessage` 收 `(TextContent|ImageContent)[]`），
  而 steam/followUp 走 `steer(text, images)` 那两个位置参数。三条路都读盘成 base64，
  与"图片实时投递"（ADR 0023）同一条判据。
- 本机少了一份可能跑偏的状态（出账簿），多了一条必须被 agent 的事件喂养的订阅；
  代价是队列快照迟一步（投递回执之后推一次），屏幕上的 chip 因此在投递那一瞬出现，
  而不是按键那一瞬。这是"单一所有者"换来的，是有意取的。

## 缺口

- 队列模式在 UI 上还没有开关，`delivery` 只有线上与领域层的通路（有测试钉住
  round-trip）。
- aside 没有本机手势：协议与桥都支持，产品上没有人能按出来。
- 队列快照与 transcript 是两条独立的推送，极端竞态下（模型在同一 tick 里吃掉一句话
  并推队列）屏幕可能先看到 chip 消失、后看到那句话进上下文；投影器按正文认领，所以
  那句话不会丢，只是顺序上的一帧闪烁。

## 相关代码

- SDK：`packages/agent-bridge/node_modules/@oh-my-pi/pi-coding-agent/src/session/agent-session.ts`
  （`steer:7248`、`followUp:7270`、`sendUserMessage:7850`、`getQueuedMessages:7946`、
  `popLastQueuedMessage:7958`、`setPromptDropped:8335`、`setSteeringMode:8814` 等）；
  注入事件在 `node_modules/.bun/@oh-my-pi+pi-agent-core@18.3.0/.../src/agent-loop.ts:1092`
- 线上形状：`packages/agent-bridge/src/protocol.ts`（`BridgeCommand` / `QueuedState`）、
  `crates/agent-client/src/wire.rs`（`DeliverAs`、`Command::Queue/Withdraw/Delivery`）
- 桥：`packages/agent-bridge/src/{bridge.ts,projection.ts}`
- 领域层：`packages/conversation/src/interjection/message-queue.ts`、
  `.../transcript/transcript-store.ts`、`.../surface/prompt-queue.tsx`、
  `.../surface/transcript/use-assistant-session.ts`
- 原生侧：`apps/desktop/native/src/conversation/{turn.rs,dto.rs}`、
  `crates/conversation/src/turn/admission.rs`、
  `crates/ledger/src/schema.sql`（`turn_admissions.deliver_as`）

（omp 行为锚定 **18.3.0**，路径以本仓 vendored 源码树为准，日期 2026-10-01。）