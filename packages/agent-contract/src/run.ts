import type {
  AcpPermissionOption,
  AcpSessionId,
  AcpSessionNotification,
  AcpStopReason,
  AcpToolCallUpdate,
} from './protocol'

export type RunStatus =
  | 'idle'
  | 'running'
  | 'awaiting_permission'
  | 'completed'
  | 'cancelled'
  | 'failed'

/**
 * The append-only run event log.
 *
 * 'acp_update' carries the protocol notification verbatim. Everything else is a
 * client-side fact about the run that the protocol does not model. Every event
 * carries a monotonic seq so replay is deterministic and duplicates are cheap
 * to discard.
 */
export type RunEvent =
  | {
      readonly kind: 'run_started'
      readonly seq: number
      readonly at: number
      readonly sessionId: AcpSessionId
      /**
       * 人说的那句话，按记录时的原文。
       *
       * 今天的生产者必发：原生侧的 RunFrame::RunStarted 把它声明为 String 而
       * 不是 Option（frame.rs）。可选说的不是它，是日志 —— 这一格加进来之前
       * 录下的帧没有它，而那些录制就在这个包里：recordings 下三份录制回放时的
       * run_started 都缺这一格。
       *
       * 日志是历史，历史改不了。同一件事这个文件里已有先例，见下面
       * permission_requested 的 toolCall 上的那句话。
       */
      readonly prompt?: string | undefined
    }
  | {
      readonly kind: 'acp_update'
      readonly seq: number
      readonly at: number
      readonly notification: AcpSessionNotification
    }
  | {
      readonly kind: 'permission_requested'
      readonly seq: number
      readonly at: number
      readonly requestId: string
      readonly toolCallId?: string
      readonly title: string
      /**
       * 被征求同意的那次操作：协议连同请求一起送来，形状就是 ToolCallUpdate。
       *
       * 一句只点了动作的提示不是一个能回答的问题 —— Write，写哪个文件，替换掉
       * 什么。可选说的不是 agent 可以不带，而是日志：这一格加进来之前录下的帧
       * 没有它，而那些录制就在本仓库里。此前手抄的类型少了 name 与 rawOutput，
       * 那是类型在瞒报线上实际到达的东西。
       */
      readonly toolCall?: AcpToolCallUpdate
      readonly options: readonly AcpPermissionOption[]
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
      readonly kind: 'run_finished'
      readonly seq: number
      readonly at: number
      readonly stopReason: AcpStopReason
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
 * RunStatus above is the truth about the run itself: six states
 * the agent and the client can genuinely be in. ChatStatus is coarser on
 * purpose — it is the four states a send button can render, and nothing more.
 *
 * It lives here rather than next to the button because the application layer
 * derives it and the presentation layer displays it. Both may depend on a
 * contract; neither may depend on the other. Collapsing RunStatus into
 * ChatStatus is an application decision and stays in useAssistantSession.
 */
export type ChatStatus = 'ready' | 'submitted' | 'streaming' | 'error'
