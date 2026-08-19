import type { KapEventPayload, KapSessionId, KapStopReason } from './kap'
import type { PermissionOption } from './permission'
import type { QuestionChoice, QuestionItem } from './question'
import type { ToolCallUpdate } from './tool-call'

export type RunStatus =
  | 'idle'
  | 'running'
  | 'awaiting_permission'
  | 'awaiting_question'
  | 'completed'
  | 'cancelled'
  | 'failed'

/** 一组题怎么结的：答了、撤了、随这一轮取消了、或是答复没能送达。 */
export type QuestionOutcome = 'answered' | 'dismissed' | 'cancelled' | 'undelivered'

/**
 * The append-only run event log.
 *
 * 'kap_event' 原样携带线上的协议原文。其余每一格都是这台机器对这一轮的判断，
 * 协议本身不描述它们。每一帧带一个单调 seq，所以重放确定、去重便宜。
 */
export type RunEvent =
  | {
      readonly kind: 'run_started'
      readonly seq: number
      readonly at: number
      readonly sessionId: KapSessionId
      /**
       * 人说的那句话，按记录时的原文。
       *
       * 生产者必发（frame.rs 的 RunStarted 声明为 String）。可选说的是日志：
       * 这一格加进来之前录下的帧没有它，而历史改不了。
       */
      readonly prompt?: string | undefined
      /** 随这句话送出去的图片，本机地址，顺序与用户挑的一致。与 prompt 同一个理由可选。 */
      readonly images?: readonly string[] | undefined
    }
  | {
      readonly kind: 'kap_event'
      readonly seq: number
      readonly at: number
      /**
       * kap 的事件帧载荷，原样进帧（frame.rs 的 RunFrame::KapEvent）。
       * 这一层一个字段都不认识 —— 认识它的是投影它的那一层。
       */
      readonly payload: KapEventPayload
    }
  | {
      readonly kind: 'permission_requested'
      readonly seq: number
      readonly at: number
      readonly requestId: string
      readonly toolCallId?: string
      readonly title: string
      /**
       * 被征求同意的那次操作。一句只点了动作的提示不是一个能回答的问题 ——
       * Write，写哪个文件，替换掉什么。可选说的是日志：这一格加进来之前录下的
       * 帧没有它。
       */
      readonly toolCall?: ToolCallUpdate
      readonly options: readonly PermissionOption[]
    }
  | {
      readonly kind: 'permission_resolved'
      readonly seq: number
      readonly at: number
      readonly requestId: string
      readonly optionId: string
      readonly outcome: 'selected' | 'cancelled'
    }
  | {
      readonly kind: 'questions_asked'
      readonly seq: number
      readonly at: number
      readonly questionId: string
      readonly toolCallId?: string
      readonly questions: readonly QuestionItem[]
    }
  | {
      readonly kind: 'questions_resolved'
      readonly seq: number
      readonly at: number
      readonly questionId: string
      readonly outcome: QuestionOutcome
      /** 题号到答复。跳过的题也在 —— 跳过一次也是答复。 */
      readonly answers: Readonly<Record<string, QuestionChoice>>
      /** 整组题的可选备注；没写就是空串。 */
      readonly note: string
    }
  | {
      readonly kind: 'run_finished'
      readonly seq: number
      readonly at: number
      /** 这一轮为什么停。 */
      readonly stopReason: KapStopReason
      /**
       * What the agent said for itself while the protocol said nothing.
       *
       * An agent may report a failure of its own and still end the turn
       * normally, so a finished turn is not automatically a successful one.
       * Present only when the turn produced no update of any kind.
       */
      readonly diagnostics?: string
    }
  | {
      readonly kind: 'run_failed'
      readonly seq: number
      readonly at: number
      readonly message: string
      /** What the agent said for itself, which is preferred to the above. */
      readonly diagnostics?: string
    }

/*
 * What the composer shows about a run.
 *
 * RunStatus above is the truth about the run itself: seven states
 * the agent and the client can genuinely be in. ChatStatus is coarser on
 * purpose — it is the four states a send button can render, and nothing more.
 *
 * It lives here rather than next to the button because the application layer
 * derives it and the presentation layer displays it. Both may depend on a
 * contract; neither may depend on the other. Collapsing RunStatus into
 * ChatStatus is an application decision and stays in useAssistantSession.
 */
export type ChatStatus = 'ready' | 'submitted' | 'streaming' | 'error'
