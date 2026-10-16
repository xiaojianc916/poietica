import type { InteractionId } from './ids'

/** `plan`：计划模式产出的计划卡片（批准 / 驳回 / 要求修改），与审批、提问并列的第三种交互。 */
export type InteractionKind = 'approval' | 'question' | 'plan'

export type InteractionState = 'pending' | 'approved' | 'rejected' | 'cancelled' | 'answered' | 'dismissed'

export interface TranscriptInteraction {
  readonly interactionId: InteractionId
  readonly interactionKind: InteractionKind
  readonly toolCallId?: string
  readonly state: InteractionState
  readonly request?: unknown
  readonly response?: unknown
}
