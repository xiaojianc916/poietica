# 0027 — 链路是一个状态，不是一个计数

## 状态

已采纳。

## 背景

链路态此前是 { attempt, of }：attempt 缺席同时表示「接上了」和「放弃了」，
屏幕分不出这两件事 —— 放弃那一刻提示消失、秒表继续转。而慢模型根本走不到
这一路：WS 健在、应用层心跳照答，只是帧不来，没有任何判据说得出话。

## 决定

1. 链路态是一个枚举，唯一定义在 crates/agent-runtime/src/link.rs：
   Linked / Waiting{since} / Retrying{attempt,of,retryAt,reason}。
2. 静默有判据：一轮在飞而 STALL_AFTER 没来过帧就报 Waiting。对照 codex 的
   stream_idle_timeout_ms。
3. 重连到顶不是链路态，是这一轮的结局：按帧 fail_turn，走既有的
   Recorder → run_events → 时间线管线。对照 codex 到顶返回 Err。
4. 可重试的传输错误在 prompt 提交这一路同样退避重试，策略与链路共用一份
   （link::backoff / link::retryable）。对照 opencode 的 session/retry.ts 与
   kimi 的 agent/stepRetry。
5. 链路态不占 seq、不进帧日志：它不属于任何一轮，重放一条对话不会重演它。

## 后果

唯一真相：判据在 agent-runtime 的 Link 里，界面侧唯一副本在
SessionControlsStore；成句由 packages/agent 的 linkNotice 负责，组件只渲染。
判据与退避可脱离 UI 与进程单测（link.rs 的 tests）。
