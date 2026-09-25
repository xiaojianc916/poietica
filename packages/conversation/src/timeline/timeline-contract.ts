import type { SessionLink } from '../agent/link'
import type { ApprovalDecision, ApprovalScope } from '../agent/permission'
import type { QuestionChoice, QuestionItem } from '../agent/question'
import type { QuestionOutcome, RunStatus } from '../agent/run'
import type {
  ToolCallContent,
  ToolCallLocation,
  ToolCallStatus,
  ToolDrawerShape,
  ToolKind,
} from '../agent/tool-call'

// 时间线投影：扁平有序的 typed entries 列表。工具调用是一等条目，按 toolCallId 寻址。

export type TimelineItemId = string

export interface MessageImage {
  readonly url?: string
  // 字节还在原生侧代取，先画占位；取失败也停在占位，不挡对话。
  readonly pending?: boolean
}

export interface MessageFile {
  readonly name: string
  readonly meta: string
}

export function fileExtensionLabel(name: string): string {
  const dot = name.lastIndexOf('.')
  const extension = dot > 0 ? name.slice(dot + 1) : ''
  return extension === '' ? '文件' : extension.slice(0, 5).toUpperCase()
}

export function formatByteSize(bytes: number | undefined): string | undefined {
  if (bytes === undefined || !Number.isFinite(bytes) || bytes < 0) {
    return undefined
  }
  if (bytes < 1024) {
    return `${String(bytes)}B`
  }
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = -1
  do {
    value /= 1024
    unit += 1
  } while (value >= 1024 && unit < units.length - 1)
  const shown =
    value >= 100 || Number.isInteger(value)
      ? String(Math.round(value))
      : value.toFixed(2).replace(/\.?0+$/, '')
  // 四舍五入能把 1023.99 推成 1024：那是下一个单位。
  if (Number(shown) >= 1024 && unit < units.length - 1) {
    return `1${units[unit + 1]}`
  }
  return `${shown}${units[unit]}`
}

export function fileMetaLabel(name: string, size: number | undefined): string {
  const kind = fileExtensionLabel(name)
  const bytes = formatByteSize(size)
  return bytes === undefined ? kind : `${kind} ${bytes}`
}

interface TimelineEntry {
  readonly id: TimelineItemId
  // 官方运行序号，不从用户气泡推断。
  readonly turn: number
  readonly at: number
}

export interface UserMessageItem extends TimelineEntry {
  readonly type: 'user_message'
  readonly text: string
  readonly images?: readonly MessageImage[]
  readonly files?: readonly MessageFile[]
  readonly skills?: readonly string[]
}

export interface AgentTextItem extends TimelineEntry {
  readonly type: 'agent_text'
  readonly text: string
  // agent 自己报的消息身份（delta 帧的 messageId），缺席退回相邻推断。
  readonly messageId?: string
  readonly sealed: boolean
}

export interface AgentThoughtItem extends TimelineEntry {
  readonly type: 'agent_thought'
  readonly text: string
  readonly messageId?: string
  readonly sealed: boolean
}

export interface DelegateChannel {
  readonly agentId: string
  readonly name: string
}

export interface ToolCallTimelineItem extends TimelineEntry {
  readonly type: 'tool_call'
  readonly toolCallId: string
  readonly title: string
  readonly kind: ToolKind
  // 由工具视图按这个工具自己的性子写全，不在这里按类别拼。
  readonly headline: string
  readonly subject: string
  readonly shape: ToolDrawerShape
  readonly isBackground?: true
  readonly status: ToolCallStatus
  // 送出的那一份与交回的那一份分开：此前写入的 diff 落在 content 里被画成了产出。
  readonly requestContent: readonly ToolCallContent[]
  readonly content: readonly ToolCallContent[]
  readonly locations: readonly ToolCallLocation[]
  readonly channels: readonly DelegateChannel[]
  readonly rawInput?: unknown
  readonly rawOutput?: unknown
  readonly startedAt: number
  readonly endedAt?: number
}

export function isTerminal(status: ToolCallTimelineItem['status']): boolean {
  return status === 'completed' || status === 'failed'
}

export function isInFlight(status: RunStatus): boolean {
  return (
    status === 'submitted' ||
    status === 'running' ||
    status === 'cancelling' ||
    status === 'awaiting_permission' ||
    status === 'awaiting_question'
  )
}

export type TodoStatus = 'pending' | 'in_progress' | 'done'

export interface TodoItem {
  readonly title: string
  readonly status: TodoStatus
}

export type BackgroundTaskStatus =
  | 'running'
  | 'completed'
  | 'failed'
  | 'timed_out'
  | 'killed'
  | 'lost'

export interface BackgroundTaskItem {
  readonly taskId: string
  readonly description: string
  readonly status: BackgroundTaskStatus
}

export interface PermissionItem extends TimelineEntry {
  readonly type: 'permission'
  readonly requestId: string
  readonly title: string
  readonly kind: ToolKind
  readonly subject: string
  readonly locations: readonly ToolCallLocation[]
  readonly resolution?: {
    readonly decision: ApprovalDecision
    readonly scope?: ApprovalScope
  }
}

export interface QuestionTimelineItem extends TimelineEntry {
  readonly type: 'question'
  readonly questionId: string
  readonly toolCallId?: string
  readonly questions: readonly QuestionItem[]
  readonly resolution?: {
    readonly outcome: QuestionOutcome
    readonly answers: Readonly<Record<string, QuestionChoice>>
    readonly note: string
  }
}

export interface LinkTimelineItem extends TimelineEntry {
  readonly type: 'link'
  readonly link: SessionLink
}

export interface InflightPromptItem extends TimelineEntry {
  readonly type: 'inflight_prompt'
  readonly promptId: string
  readonly settled?: true
}

export type CompactionState = 'running' | 'blocked' | 'cancelled' | 'completed'

export interface CompactionTimelineItem extends TimelineEntry {
  readonly type: 'compaction'
  readonly agentId: string
  readonly state: CompactionState
  readonly trigger?: 'manual' | 'auto'
  readonly instruction?: string
  readonly turnId?: number
  readonly tokensBefore?: number
  readonly tokensAfter?: number
}

export interface ErrorItem extends TimelineEntry {
  readonly type: 'error'
  readonly message: string
}

export type TimelineItem =
  | UserMessageItem
  | AgentTextItem
  | AgentThoughtItem
  | ToolCallTimelineItem
  | PermissionItem
  | QuestionTimelineItem
  | LinkTimelineItem
  | InflightPromptItem
  | CompactionTimelineItem
  | ErrorItem

// 终态耗时以 transcript 的 durationMs 为准；时间戳只负责运行态推进。
export interface TurnSpan {
  readonly turn: number
  readonly durationMs?: number
  readonly startedAt?: number
  readonly endedAt?: number
  readonly lastFrameAt?: number
}

// 封口之后不再改写，跨帧按引用共享。
export interface TurnPage {
  readonly turn: number
  readonly run?: {
    readonly settled: boolean
    readonly undoCount: number | null
    readonly forkUnavailableReason: string | null
  }
  readonly items: readonly TimelineItem[]
}

export interface TimelineState {
  readonly status: RunStatus
  readonly backgroundTasks: readonly BackgroundTaskItem[]
  readonly sealed: readonly TurnPage[]
  readonly active: TurnPage
  // 已收到的最大序号；去重只需要它（帧走单条有序 IPC，「到过」等价于「不大于它」）。
  readonly lastSeq: number
  readonly spans: readonly TurnSpan[]
}

// 热路径不走它：摊平正是分段要省掉的复制。给测试与诊断读全量用。
export function allItems(state: TimelineState): readonly TimelineItem[] {
  return [...state.sealed.flatMap((page) => page.items), ...state.active.items]
}
