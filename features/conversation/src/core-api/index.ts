import { type CoreEvent, defineCoreEvent } from '@poietica/core-kernel/events'
import type { ModelRef, Posture, UsageSample } from '@poietica/engine'
import { defineServiceToken } from '@poietica/foundation'
import type { Thread } from '../contract'

export interface ConversationService {
  createThread(init: {
    workspaceId: string
    title: string
    origin: 'user' | 'automation'
    posture: Posture
    model: ModelRef | null
    thinking: string | null
  }): Thread
  /** 等价于 turns.submit（deliverAs:'turn'，无附件、无技能） */
  submit(input: { threadId: string; text: string }): Promise<void>
  cancel(threadId: string): Promise<void>
  get(threadId: string): Thread | null
}
export const ConversationServiceToken = defineServiceToken<ConversationService>('conversation', 'ConversationService')

export interface TurnSettled {
  readonly threadId: string
  readonly outcome: 'completed' | 'cancelled' | 'failed'
  readonly error: { code: string; message: string } | null
}
export const turnSettled: CoreEvent<TurnSettled> = defineCoreEvent<TurnSettled>('conversation', 'turnSettled')

/**
 * 一句话没能交给 omp（冷打开失败、引擎在开轮前拒收、被判 dropped、Core 重启）。
 *
 * 「Core 即时回显」之后，提交有独立于轮次的生命周期：`failed` 这个结局**不经过任何一轮**，
 * 所以不会有 turnSettled。这条事件就是那个结局的广播 —— automations 靠它把「永远运行中」
 * 的运行记录收口（R-06）。
 */
export interface SubmissionFailed {
  readonly threadId: string
  readonly clientTurnId: string
  readonly deliverAs: 'turn' | 'steer' | 'followUp'
  readonly error: { readonly code: string; readonly message: string }
}
export const submissionFailed: CoreEvent<SubmissionFailed> = defineCoreEvent<SubmissionFailed>(
  'conversation',
  'submissionFailed',
)

/** 线程被删除（用户删除 / 工作区级联）：按线程索引的订阅方靠它清账 */
export interface ThreadRemoved {
  readonly threadId: string
}
export const threadRemoved: CoreEvent<ThreadRemoved> = defineCoreEvent<ThreadRemoved>('conversation', 'threadRemoved')

export interface UsageSampled {
  readonly threadId: string
  readonly sample: UsageSample
  readonly at: number
}
export const usageSampled: CoreEvent<UsageSampled> = defineCoreEvent<UsageSampled>('conversation', 'usageSampled')

/**
 * 用户发出去了一句话（准入）。
 *
 * legacy 的对应物是账本里的 turn_admissions：每落一行就是用户说出来的一句，插话也算
 * ——ADR 0039 把它定成用量页「消息数量」那一格的唯一口径（不是模型采样条数）。
 * 新架构里「一句话进没进会话」只有 conversation 知道（它拿着回合的准入），所以这件事
 * 由这里发出来，用量功能的 core 订阅后落进自己的日账（与 usageSampled 同一条路）。
 */
export interface UserMessageSubmitted {
  readonly threadId: string
  readonly at: number
}
export const userMessageSubmitted: CoreEvent<UserMessageSubmitted> = defineCoreEvent<UserMessageSubmitted>(
  'conversation',
  'userMessageSubmitted',
)
