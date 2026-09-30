# 插话路径：改前 / 改后

本文是 ADR 0026 的对照说明：同一件事（流式中发消息）在两条实现下分别怎么走，差在哪。
锚定 omp **18.3.0**，日期 2026-10-01。

## 一句话

改前：本机排一个出账簿，等这一轮跑完、再把它当**新一轮**发出去。
改后：那句话**当场插进正在跑的那一轮**，走 agent 自己的双队列 —— 插话就是插话，不是下一轮。

## 改前

```text
按 Enter（流式中）
  → use-assistant-session.send
  → InterjectionOutbox.queue(正文)          ← 本机第二份队列
  → 屏幕画 chip（本机状态）
  → …等这一轮 turn_end…
  → outbox.release() 依次取出一条
  → sendPrompt(正文)                        ← 当**新的一轮**发
  → agent.prompt(text)
```

三个硬伤（都能指到代码）：

1. **档位是空的。** 线上只有一条插话命令 `agent_steer { threadId, promptIds }`，
   Rust 侧 `prompt_ids.join("\n")` 之后投给桥 —— 过去的是**账本里的 prompt 号**
   （`"3f2a-…"`），不是那句话。omp 的 `steer` / `followUp` / `aside` 三层一层都没接上。
2. **撞忙碌错。** `sendPrompt` 无条件调 `agent.prompt(text)`；流式中不带
   `streamingBehavior` 时上游抛 `AgentBusyError`（`agent-session.ts:6467`）。本机补一条
   「这一轮没起来」的失败轮终 —— 那句话既没排上队也没进上下文。
3. **队列排了两份。** 出账簿记「排着哪些话」，agent 的队列也记。两份状态一让步调就不
   一致（屏幕排着、agent 那边没有），违反「每类状态只有一个所有者」。

## 改后

```text
按 Enter（流式中）
  → use-assistant-session.send
       deliverAs 缺省 → canCancel(在飞) ? 'steer' : 'turn'
  → TranscriptStore.send → port.prompt({ deliverAs })
  → 桥 deliverPrompt 按档分派
       steer    → agent.steer(text, images)      ← 工具批次之间注入
       followUp → agent.followUp(text, images)   ← 本轮跑完自动接下一轮
       aside    → sendUserMessage(…, {deliverAs:'aside'})  ← step 边界静默注入
       turn     → agent.prompt(text)
  → agent 自己的队列持有它（getQueuedMessages 报出来）
  → 屏幕画 chip（agent 报的快照）
  → 模型真的看见时：message_start → 桥按正文认领 → 投影器画进当前 step
```

## 逐项对照

| | 改前 | 改后 |
| --- | --- | --- |
| 投出去的正文 | 账本里的 **prompt 号** | 那一句话本身 |
| 层的选择 | 不存在（只有一条 `steer` 命令） | `deliverAs` 四档：turn / steer / followUp / aside |
| 生效时机 | 等 `turn_end`，当**新一轮** | 按档：批次之间 / 本轮之后 / step 边界 / 开一轮 |
| 队列归谁 | 本机出账簿（+ agent 里那份，两份） | **只有 agent**（本机只订快照） |
| 撤回 | 按号删，可拖拽重排 | `popLastQueuedMessage`（**LIFO**，只有最后一句能撤） |
| 队列模式 | 无 | `steering/followUp/interruptMode` 可运行期切换，落 agent config |
| 流式中送图 | 不支持 | 三条路都支持（与图片实时投递同一条判据） |
| 忙碌错 | 抛出并吞掉那句话 | 界面默认选 steer（上游对插话永不抛忙碌错） |
| 掉单 | 那句话凭空消失 | `setPromptDropped` → 收成失败并说明「没有落进会话」 |
| 取消后队列 | 本机自己决定 | 上游语义：**不排空**，chip 仍在 |
| 屏幕那一格 | 投影器按「新轮」画 | 开着一轮 ⇒ 本轮的一句；没开着 ⇒ 它自己开一轮 |

## 手势

沿用 omp 自己 TUI 的既有手势（`input-controller.ts:1219-1229`）：

- 流式中 **Enter** = steer（插进当前这一轮）
- **Ctrl/⌘+Enter** = followUp（本轮跑完接着做）
- `aside` 不做本机手势：协议与桥都通了，但产品上没有入口（omp 的 TUI 也没有）

## 本机留下的东西

删掉了出账簿（`interjection-outbox.ts`）。本机只剩：

- `MessageQueue`：把 agent 报来的快照按对话存一份供屏幕订阅；
- 三个写动作的转发：撤回（LIFO）、改模式、读一次补缺口；
- 认领账本（桥内）：按**正文**认自己投出去还没露面的那一条 —— 开场白也走同一对
  `message_start`，所以判据必须是「这条正文是不是我投的」。

## 验收

```bash
bun run check
```

覆盖：wire 两侧（`protocol.ts` / `wire.rs`）、桥（含 9 条插话层测试）、Rust
（agent-client / conversation-runtime / IPC / 契约再生成）、conversation 层与 UI。

## 相关

- ADR [0026](../adr/0026-interjection-follows-the-agents-own-queues.md)
- SDK 契约锚点、三条已知缺口都在 ADR 里