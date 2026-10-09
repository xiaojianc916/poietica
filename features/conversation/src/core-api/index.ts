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
