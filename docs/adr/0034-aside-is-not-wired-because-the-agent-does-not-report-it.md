# 0034. 不接 omp 的 aside 档：上游不报它何时被吃掉

- 状态：已接受，**取代 ADR 0026 的决策 4**（那一句"队列快照里没有它的位置"）
- 日期：2026-10-03
- 归属：agent-bridge / conversation / 待发队列

## 背景

ADR 0026 决策 4 把 aside 留在协议里、不做本机入口，判词是"队列快照里没有它的位置 ——
编一格假的只会让屏幕说一句 agent 没说过的话"。后来给它加了手势，两版都错，用户两次
当场报了出来：

> 点击 aside 后就直接消失了，过了好一会又莫名其妙发送了……不要随便消失啊
>
> 点击 aside 怎么现在一直在了，算了算了，把 aside 删除，反正这个模式没有用

两次都在同一个前提上翻车：**上游不报 aside 的生死**。

- 它不进 `getQueuedMessages()` 那两个队列（走 IRC 旁路，`queuedMessageCount` 也不算它），
  所以"还排着吗"这个问题对它无从问起。
- 它被折进上下文时确实会发 `message_start`（与开场白同一对事件），但那是**认领**，
  不是**投递**；两者之间隔着"等到下一个 step 边界"，可能很久，也可能跨过整轮。
- 上游刻意让旁注跨过 abort 活着（`agent-session.ts:1008` 的 `#resumeStrandedIrcAsides`：
  "stranded asides survive an aborted turn by design"）。

于是本机只有两个坏选择：

1. **不报它** → 按下去那一行凭空消失，过一会儿又从 transcript 冒出来（第一版）。
2. **一直报它** → 认领之前它永远在，而"认领之前"没有上界；屏幕上一行永不消失（第二版）。

两者都不是"屏幕如实说 agent 说的那件事"。

## 决策

**aside 整档不接：产品面、线上形状、领域模型、账本读法一起删。**

- 线上 `deliverAs` 只剩三档 `turn / steer / followUp`（`protocol.ts` 与 `wire.rs` 同时改，
  两侧有逐字回归测试钉住字面量）。
- 领域 `DeliverAs` 删掉 `Aside`；`QueuedState` 删掉 `aside` 那一格（四处同步 + 生成绑定）。
- 桥里那条 `sendUserMessage({deliverAs:'aside'})` 分支删掉，并在 `deliverPrompt` 上加一道
  **显式拒绝**：认不出来的档位当场报错，不许落进 else 被当成 followUp 排进队列。
- 屏幕上没有旁注按钮，也没有旁注行。

**已落盘的 `deliver_as = 'aside'` 行按 `Turn` 重放。** `DeliverAs::from_stored` 的兜底
本来就是 `Turn`，`"aside"` 现在落进那一支 —— 与它当年"空闲时退成一轮"的上游语义一致，
不会静默丢掉那句话。迁移不追加：这一格是**读法**变了，不是数据形状变了。

## 后果

- 插话只剩两层：`steer`（插进正在跑的这一轮）与 `followUp`（这一轮跑完接着做）。
  两者都排在上游那两个队列里，`getQueuedMessages()` 报得出来，屏幕画的每一行都有
  唯一的、会终结的来处。
- 少了一档"完全不打断"的投递。上游仍然有它，本仓只是不接；要用得先解决"它何时被吃掉"
  这个观测缺口（上游得给一个读法，或一个能删单条旁注的 API）。
- `DeliverAs::is_interjection()` 的语义不变（`!Turn`）。

## 相关代码

- 桥：`packages/agent-bridge/src/{bridge.ts,protocol.ts}`
- 领域层：`packages/conversation/src/{agent/session.ts,interjection/message-queue.ts,surface/prompt-queue.tsx}`
- 原生：`apps/desktop/native/src/conversation/dto.rs`、`crates/agent-client/src/{wire.rs,session/}`、
  `crates/conversation/src/turn/admission.rs`
- SDK 锚点（18.3.0）：`session/agent-session.ts` 的 `sendUserMessage:7850`、
  `#queueUserMessage:7341`、`#resumeStrandedIrcAsides:1008`、`getQueuedMessages:7946`