import type { KapEventPayload, KapSessionId, KapStopReason } from './kap'
import type { SessionLink } from './link'
import type { ApprovalDecision, ApprovalScope } from './permission'
import type { QuestionChoice, QuestionItem } from './question'
import type { ToolCallUpdate } from './tool-call'

export type RunStatus =
  | 'idle'
  | 'submitted'
  | 'running'
  | 'cancelling'
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
      readonly kind: 'prompt_admitted'
      readonly seq: number
      readonly at: number
      readonly sessionId: KapSessionId
      readonly admissionId: string
      /**
       * 人说的那句话，按记录时的原文。
       *
       * 生产者必发（frame.rs 的 PromptAdmitted 声明为 String）。可选说的是日志：
       * 这一格加进来之前录下的帧没有它，而历史改不了。
       */
      readonly prompt?: string | undefined
      /** 随这句话送出去的图片，本机地址，顺序与用户挑的一致。与 prompt 同一个理由可选。 */
      readonly images?: readonly string[] | undefined
      /** 随这句话挂上的技能名，顺序与用户选的一致。与 prompt 同一个理由可选。 */
      readonly skills?: readonly string[] | undefined
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
    }
  | {
      readonly kind: 'permission_resolved'
      readonly seq: number
      readonly at: number
      readonly requestId: string
      /** 这次审批按 kap 的话是怎么结的（frame.rs 的 PermissionResolved）。 */
      readonly decision: ApprovalDecision
      /** 「这条会话都照此办理」时在场。 */
      readonly scope?: ApprovalScope
      /** 计划复审所选方案的协议 label；普通审批不出现。 */
      readonly selectedLabel?: string
      /** 给 agent 的可选留言。 */
      readonly feedback?: string
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
      readonly kind: 'session_recovered'
      readonly seq: number
      readonly at: number
      /** 恢复续接用的原子快照（frame.rs 的 RunFrame::SessionRecovered）。 */
      readonly snapshot: Readonly<Record<string, unknown>>
    }
  | {
      readonly kind: 'link_changed'
      readonly seq: number
      readonly at: number
      /** 这条连接此刻的链路态（frame.rs 的 RunFrame::LinkChanged）。 */
      readonly link: SessionLink
    }
  | {
      readonly kind: 'run_finished'
      readonly seq: number
      readonly at: number
      /** 这一轮为什么停。 */
      readonly stopReason: KapStopReason
      /* Rust RunFinished 只携带 stopReason。 */
    }
  | {
      readonly kind: 'run_failed'
      readonly seq: number
      readonly at: number
      readonly message: string
      /* Rust RunFailed 只携带 message。 */
    }

/*
 * What the composer shows.
 *
 * RunStatus above is the truth about the run. ChatStatus is coarser on purpose:
 * it is what a send button can render. 'queued' is not a run state —— 那一轮确实
 * 在跑；它说的是这条对话还有话排在它后面，而这正是 RunStatus 表达不了的那一件事。
 *
 * It lives here rather than next to the button because the application layer
 * derives it and the presentation layer displays it. Both may depend on a
 * contract; neither may depend on the other. Collapsing RunStatus and the queue
 * into ChatStatus is an application decision and stays in useAssistantSession.
 */
export type ChatStatus = 'ready' | 'submitted' | 'streaming' | 'queued' | 'cancelling' | 'error'
