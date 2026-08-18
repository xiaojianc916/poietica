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

/**
 * 一次工具调用的类别。
 *
 * 不是 kap 的字段：kap 报的是 display.kind（command / search / url_fetch /
 * file_io / diff），映到这张表的是 kap-projection 的 readDisplay。图标分流与
 * tool-call-facets 的写入合成读的都是它。
 */
export type KapToolKind = 'edit' | 'execute' | 'fetch' | 'other' | 'read' | 'search'

/** 一次工具调用的生命周期。终态判据归 timeline-contract 的 isTerminal。 */
export type KapToolCallStatus = 'completed' | 'failed' | 'in_progress' | 'pending'

/** 这次调用碰的位置。行号是标题栏与编辑器的事，这里只留路径。 */
export interface KapToolCallLocation {
  readonly path: string
}

/** 一次工具调用交出来的一段内容。文本以外的块只报名字，不猜形状。 */
export type KapToolCallContent =
  | {
      readonly type: 'content'
      readonly content:
        | { readonly type: 'text'; readonly text: string }
        | { readonly type: 'audio' | 'image' | 'resource' | 'resource_link' }
    }
  | {
      readonly type: 'diff'
      readonly path: string
      readonly oldText: string | null
      readonly newText: string
    }
  | { readonly type: 'terminal'; readonly terminalId: string }

/** 一次工具调用的部分更新；授权请求随身带的那份就是它（frame.rs 只填三格）。 */
export interface KapToolCallUpdate {
  readonly toolCallId?: KapToolCallId
  readonly title?: string
  readonly kind?: KapToolKind
  readonly status?: KapToolCallStatus
  readonly content?: readonly KapToolCallContent[]
  readonly locations?: readonly KapToolCallLocation[]
  readonly rawInput?: unknown
  readonly rawOutput?: unknown
}

/**
 * 一次授权请求的答复选项。
 *
 * kap 的审批帧不带选项清单，这三条由原生侧按 kap 的答复面合成
 * （agent-runtime 的 permission.rs：kap_options / kap_response）。
 */
export interface KapPermissionOption {
  readonly optionId: string
  readonly name: string
  readonly kind: 'allow_always' | 'allow_once' | 'reject_once'
}
