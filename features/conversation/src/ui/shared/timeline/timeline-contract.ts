import { formatBytes } from '@poietica/design-system'
import type { TranscriptUsage } from '@poietica/transcript'
import type { DialogRequest } from '../model/dialog'
import type { SessionLink } from '../model/link'
import type { ApprovalDecision, ApprovalScope } from '../model/permission'
import type { QuestionChoice, QuestionItem } from '../model/question'
import type { QuestionOutcome, RunStatus } from '../model/run'
import type { ToolCallContent, ToolCallLocation, ToolCallStatus, ToolDrawerShape, ToolKind } from '../model/tool-call'

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

/** 字节数的界面写法：格式化只有 design-system 那一份（`formatBytes`），这里只补「没报大小就不写」这一条。 */
export function formatByteSize(bytes: number | undefined): string | undefined {
  if (bytes === undefined || !Number.isFinite(bytes) || bytes < 0) {
    return undefined
  }
  return formatBytes(bytes)
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
  /**
   * 真实 turn 到达时带着它，界面拿它把 Core 的「提交行」换成真实的那一轮（同一 key、同一组件，DOM 原地更新）。历史回放里没有提交号的轮没有这一格。
   */
  readonly clientTurnId?: string
  /**
   * 排过队 / 插过话的那些没有真实轮次可换（omp 的队列住进程内存里，Core 崩溃就没了），所以按「未送达」画成一个用户气泡（R-08-5）。
   */
  readonly undelivered?: boolean
  readonly images?: readonly MessageImage[]
  readonly files?: readonly MessageFile[]
  readonly skills?: readonly string[]
}

interface AgentTextItem extends TimelineEntry {
  readonly type: 'agent_text'
  readonly text: string
  // agent 自己报的消息身份（delta 帧的 messageId），缺席退回相邻推断。
  readonly messageId?: string
  readonly sealed: boolean
}

interface AgentThoughtItem extends TimelineEntry {
  readonly type: 'agent_thought'
  readonly text: string
  readonly messageId?: string
  readonly sealed: boolean
}

interface DelegateChannel {
  readonly agentId: string
  readonly name: string
}

export interface ToolCallTimelineItem extends TimelineEntry {
  readonly type: 'tool_call'
  readonly toolCallId: string
  readonly title: string
  /** 平时与 title 同值，只有 `write xd://<工具>` 不同 —— 帧上是 write，跑的是被挂载的那个设备。 */
  readonly invokedTool: string
  /**
   * read/write 是传输工具，名字回答不了「在读文件还是读技能」—— 地址回答得了。空串表示不是内部资源。
   */
  readonly scheme: string
  readonly kind: ToolKind
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
    status === 'awaiting_plan' ||
    status === 'awaiting_question'
  )
}

export type TodoStatus = 'pending' | 'in_progress' | 'done'

export interface TodoItem {
  readonly title: string
  readonly status: TodoStatus
}

export type BackgroundTaskStatus = 'running' | 'completed' | 'failed' | 'timed_out' | 'killed' | 'lost'

export interface BackgroundTaskItem {
  readonly taskId: string
  readonly description: string
  readonly status: BackgroundTaskStatus
  readonly startedAt?: number
  readonly endedAt?: number
}

/*
 * 与 `BackgroundTaskItem` **分开**是有意的：后台任务那一节画的是 shell/工具的作业（图标就是终端），子代理是「智能体」那一节的事 ——
 * 合成一个类型，把子代理塞进后台任务那一格就只是类型允许、语义错误。`agentId` 是 omp 给这个子代理签的号（形如 `Anna`、`Anna-2`）。
 */
export interface SubagentItem {
  readonly agentId: string
  readonly description: string
  readonly status: BackgroundTaskStatus
  readonly startedAt?: number
  readonly endedAt?: number
}

export interface PermissionItem extends TimelineEntry {
  readonly type: 'permission'
  readonly requestId: string
  readonly title: string
  /**
   * 「要不要允许 Bash」回答不了任何问题，人要知道的是**将跑哪条命令**；它是多行原文，带子只截第一行，所以单独一格。
   */
  readonly headline?: string
  readonly kind: ToolKind
  readonly subject: string
  readonly locations: readonly ToolCallLocation[]
  readonly resolution?: {
    readonly decision: ApprovalDecision
    readonly scope?: ApprovalScope
  }
}

/**
 * 与审批分开成一类，因为卡片上要画的是**正文**（Markdown），而审批那一格画的是「将要执行什么」。`resolution` 记终态：已批准 / 已要求修改 / 已否决。
 */
export interface PlanItem extends TimelineEntry {
  readonly type: 'plan'
  readonly requestId: string
  readonly title: string
  readonly planFilePath: string
  readonly planMarkdown: string
  readonly resolution?:
    | { readonly decision: 'approved' }
    | { readonly decision: 'rejected' }
    | { readonly decision: 'revise'; readonly feedback: string }
    | { readonly decision: 'cancelled' }
}

export interface QuestionTimelineItem extends TimelineEntry {
  readonly type: 'question'
  readonly questionId: string
  readonly toolCallId?: string
  readonly questions: readonly QuestionItem[]
  /**
   * 在场时这不是 ask 的题组，而是一道单问（确认 / 单选 / 输入，Q1-E）：`questions` 为空，输入框那张卡画单问面板，
   * 答复按它自己的种类回去。与题组同排一条队列、同一档 `awaiting_question`，所以借这一类而不另开一类条目。
   */
  readonly dialog?: DialogRequest
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

interface InflightPromptItem extends TimelineEntry {
  readonly type: 'inflight_prompt'
  readonly promptId: string
  readonly settled?: true
}

/** failed = agent 报了错、这次没压成（与 cancelled 分开：一个是人按了停，一个是出了事） */
export type CompactionState = 'running' | 'blocked' | 'cancelled' | 'completed' | 'failed'

export interface CompactionTimelineItem extends TimelineEntry {
  readonly type: 'compaction'
  readonly agentId: string
  readonly state: CompactionState
  readonly trigger?: 'manual' | 'auto'
  readonly instruction?: string
  readonly turnId?: number
  readonly tokensBefore?: number
  readonly tokensAfter?: number
  /** 压缩摘要（agent 给什么就是什么；展开那一面读它） */
  readonly summary?: string
  /** 失败时 agent 报的原因 */
  readonly error?: string
  /** 压完仍然腾不出空间之类的事后告警 */
  readonly warning?: string
  /** 这份摘要已被后一次压缩取代（agent 只留了占位，不是摘要） */
  readonly superseded?: true
}

interface ErrorItem extends TimelineEntry {
  readonly type: 'error'
  readonly message: string
  /** error = 红色感叹号；warning = 三角、安静色（R-09）。info 不进时间线。 */
  readonly level: 'error' | 'warning'
}

export type TimelineItem =
  | UserMessageItem
  | AgentTextItem
  | AgentThoughtItem
  | ToolCallTimelineItem
  | PermissionItem
  | PlanItem
  | QuestionTimelineItem
  | LinkTimelineItem
  | InflightPromptItem
  | CompactionTimelineItem
  | ErrorItem

export interface TurnSpan {
  readonly turn: number
  readonly durationMs?: number
  readonly startedAt?: number
  readonly endedAt?: number
  readonly lastFrameAt?: number
}

/**
 * 一轮怎么结束的（DSH 的 `turn.end.reason.kind`）。封条的三档文案与「不封」都由它解出：
 * 被打断与出错的那一轮永远摊开（人要看的是它坏在哪），正常答完的才谈得上折叠。
 * 快照还没报出终局时为 undefined（排队 / 在跑）。
 */
export type TurnOutcome = 'completed' | 'aborted' | 'error'

// 封口之后不再改写，跨帧按引用共享。
export interface TurnPage {
  readonly turn: number
  readonly run?: {
    readonly settled: boolean
    /** 从这一轮分叉 = 只留前 keepTurns 轮（就是这一轮的轮号）；null = 此刻不能分叉，原因见 forkUnavailableReason */
    readonly keepTurns: number | null
    readonly forkUnavailableReason: string | null
  }
  readonly outcome?: TurnOutcome
  readonly usage?: TranscriptUsage
  readonly items: readonly TimelineItem[]
}

export interface TimelineState {
  readonly status: RunStatus
  readonly backgroundTasks: readonly BackgroundTaskItem[]
  readonly subagents: readonly SubagentItem[]
  readonly sealed: readonly TurnPage[]
  readonly active: TurnPage
  readonly spans: readonly TurnSpan[]
}

export function createTimelineState(): TimelineState {
  return {
    status: 'idle',
    backgroundTasks: [],
    subagents: [],
    sealed: [],
    active: { turn: 0, items: [] },
    spans: [],
  }
}
