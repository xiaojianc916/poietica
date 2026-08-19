/**
 * kap 的词汇表：会话事件载荷与轮终原因。
 *
 * 形状的唯一权威是上游 kap-server 的 protocol/events-zod.ts，快照钉在
 * contracts/kap（kap:spec:check 守漂移）。这里只声明投影需要的最小前提：
 * 载荷带一个 type 判别式。认识每一个字段的是投影那一层（packages/agent 的
 * kap-projection.ts），契约这一层不为它不认识的东西写字段。
 */

/** 一帧 kap_event 的载荷：kap 事件信封里的事件本体（信封的 type 就是它的 type）。 */
export type KapEventPayload = {
  readonly type: string
} & Readonly<Record<string, unknown>>

/**
 * 一轮按 agent 的说法结束时的原因。
 *
 * 上游的 turnEndReason 有四个（events-zod.ts），但 failed 与 blocked 在原生侧
 * 走 run_failed，所以 run_finished 这一格里只会出现这两个。
 */
export type KapStopReason = 'completed' | 'cancelled'

/** kap 发的会话号；协议签发，本侧只搬运。 */
export type KapSessionId = string

/** 一次工具调用的号：kap 事件里的 toolCallId。 */
export type KapToolCallId = string
