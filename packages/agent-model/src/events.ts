import { z } from 'zod'
import {
  agentTranscriptSnapshotSchema,
  attachmentSchema,
  interactionSchema,
  noticeFrameSchema,
  stepHeaderSchema,
  transcriptFrameSchema,
  transcriptMarkerSchema,
  transcriptMetaMergeSchema,
  transcriptPromptSchema,
  transcriptTaskRefSchema,
  transcriptTaskSchema,
  turnHeaderSchema,
} from './contract/schema'
import type { TranscriptAttachment } from './model/attachment'
import type { TranscriptFrame } from './model/frame'
import type { TranscriptInteraction } from './model/interaction'
import type { TranscriptMarker, TranscriptTaskRef } from './model/item'
import type { TranscriptMetaMerge } from './model/meta'
import type { TranscriptPrompt } from './model/prompt'
import type { TranscriptTask } from './model/task'
import type { TranscriptTodo } from './model/todo'
import type { TranscriptUsage } from './model/turn'
import type { AgentTranscriptSnapshot, StepHeader, TurnHeader } from './ops/operation'

/*
 * AgentEvent 是 Poietica 自有的产品事件语言（架构设计 §6）。
 *
 * 它只包产品需要的东西：归属、持久性、序号、omp 侧引用和载荷。对话条目的载荷直接沿用
 * 时间线模型（消息、工具参数与结果的原样形状由 omp-types 在边界上收紧），这里不另造一套
 * 中立结构。`committed` 事件可重放、可叠加；`ephemeral` 只用于实时覆盖，对应条目提交后丢弃。
 *
 * 类型手写、schema 单独维护：zod 的推断会把 readonly 放宽成可变数组，与模型在
 * exactOptionalPropertyTypes 下的形状不同；两边同形由编译期断言钉住（见文件末尾）。
 */

export type EventDurability = 'committed' | 'ephemeral'

export const ompRefSchema = z.object({
  /** omp 会话文件；跨进程/重开时用它把产品事件挂回对话正文 */
  sessionFile: z.string().optional(),
  /** omp 会话条目号（session entry id） */
  entryId: z.string().optional(),
  /** omp 的工具调用号 */
  toolCallId: z.string().optional(),
})
export type OmpRef = z.infer<typeof ompRefSchema>

interface AgentEventBase {
  /** 事件模式版本：每种事件单独演进，只增不改 */
  readonly schema: number
  /** 发生时间（ISO 8601） */
  readonly at: string
  readonly threadId?: string
  readonly agentId?: string
  readonly runId?: string
  readonly itemId?: string
  /** 线程内单调序号；由 Core 在写入 Journal 时签发，瞬态事件不带 */
  readonly seq?: number
  readonly ompRef?: OmpRef
}

interface CommittedBase extends AgentEventBase {
  readonly durability: 'committed'
}

interface EphemeralBase extends AgentEventBase {
  readonly durability: 'ephemeral'
}

export type AgentEvent =
  | (CommittedBase & { readonly type: 'thread.titled'; readonly title: string; readonly source: 'auto' | 'user' })
  | (CommittedBase & {
      readonly type: 'thread.forked'
      readonly parentThreadId: string
      readonly fromRunId?: string
    })
  | (CommittedBase & { readonly type: 'thread.archived' })
  | (CommittedBase & { readonly type: 'run.queued'; readonly run: TurnHeader })
  | (CommittedBase & { readonly type: 'run.started'; readonly run: TurnHeader })
  | (CommittedBase & { readonly type: 'run.input_enqueued'; readonly prompt: TranscriptPrompt })
  | (CommittedBase & { readonly type: 'run.input_withdrawn'; readonly prompt: TranscriptPrompt })
  | (CommittedBase & { readonly type: 'run.input_consumed'; readonly prompt: TranscriptPrompt })
  | (CommittedBase & { readonly type: 'run.input_dropped'; readonly prompt: TranscriptPrompt })
  | (CommittedBase & {
      readonly type: 'run.completed'
      readonly runId: string
      readonly outcome: 'completed' | 'failed' | 'cancelled' | 'interrupted'
      readonly endedAt?: string
      readonly usage?: TranscriptUsage
      readonly durationMs?: number
      readonly error?: string
    })
  | (CommittedBase & { readonly type: 'step.started'; readonly turnId: string; readonly step: StepHeader })
  | (CommittedBase & { readonly type: 'step.retrying'; readonly turnId: string; readonly step: StepHeader })
  | (CommittedBase & { readonly type: 'step.completed'; readonly turnId: string; readonly step: StepHeader })
  | (CommittedBase & {
      readonly type: 'item.started'
      readonly turnId: string
      readonly stepId: string
      readonly frame: TranscriptFrame
    })
  | (CommittedBase & {
      readonly type: 'item.completed'
      readonly turnId: string
      readonly stepId: string
      readonly frame: TranscriptFrame
    })
  | (CommittedBase & {
      readonly type: 'item.failed'
      readonly turnId: string
      readonly stepId: string
      readonly frame: TranscriptFrame
    })
  | (EphemeralBase & {
      readonly type: 'item.delta'
      readonly turnId: string
      readonly stepId: string
      readonly frameId: string
      readonly channel: 'text' | 'thinking' | 'tool_input' | 'tool_output' | 'progress'
      /** 已发出的字符数（text/thinking/tool_output）；缺省表示整份替换 */
      readonly offset?: number
      readonly text?: string
      readonly data?: unknown
    })
  | (CommittedBase & { readonly type: 'item.removed'; readonly ids: readonly string[] })
  | (CommittedBase & { readonly type: 'interaction.requested'; readonly interaction: TranscriptInteraction })
  | (CommittedBase & { readonly type: 'interaction.resolved'; readonly interaction: TranscriptInteraction })
  | (CommittedBase & {
      readonly type: 'context.compacted' | 'marker.raised'
      readonly item: TranscriptMarker
      readonly beforeTurn?: number
    })
  | (CommittedBase & {
      readonly type: 'task.linked'
      readonly item: TranscriptTaskRef
      readonly beforeTurn?: number
    })
  | (CommittedBase & { readonly type: 'task.started' | 'task.finished'; readonly task: TranscriptTask })
  | (EphemeralBase & {
      readonly type: 'task.output'
      readonly taskId: string
      readonly offset?: number
      readonly text: string
    })
  | (CommittedBase & { readonly type: 'attachment.added'; readonly attachment: TranscriptAttachment })
  | (CommittedBase & { readonly type: 'todo.updated'; readonly todo: TranscriptTodo })
  | (CommittedBase & { readonly type: 'prompt.updated'; readonly prompt: TranscriptPrompt })
  | (CommittedBase & { readonly type: 'agent.updated'; readonly meta: TranscriptMetaMerge })
  | (CommittedBase & {
      readonly type: 'notice.raised'
      readonly turnId: string
      readonly stepId: string
      readonly frame: TranscriptFrame
    })
  | (CommittedBase & {
      readonly type: 'checkpoint.created'
      readonly checkpointId: string
      readonly workspaceRoot: string
      readonly label?: string
      readonly reason: 'turn_start' | 'turn_end' | 'step' | 'manual' | 'revert'
    })
  | (CommittedBase & {
      readonly type: 'policy.decided'
      readonly toolName: string
      readonly category: string
      readonly action: 'allow' | 'ask' | 'deny'
      readonly rule: string
      readonly reason: string
      readonly preset: string
      /** 工具分类的风险等级：审计按风险筛选要它（缺省来自分类表） */
      readonly risk?: 'none' | 'low' | 'medium' | 'high'
      /** 这次调用发生在哪个工作区：审计按工作区筛选要它 */
      readonly workspaceRoot?: string
      /** omp 的工具调用号：把它挂回时间线上的那一格 */
      readonly toolCallId?: string
    })
  | (CommittedBase & {
      readonly type: 'policy.granted'
      readonly toolName: string
      readonly grantId: string
      readonly sessionKey: string
      readonly expiresAt: number
    })
  | (CommittedBase & {
      readonly type: 'policy.revoked'
      readonly grantId: string
      readonly toolName?: string
      readonly sessionKey?: string
      /** 撤销时那条记录还在不在：false = 早就过期或已被删掉，列表因此要重读 */
      readonly removed: boolean
    })
  | (CommittedBase & {
      readonly type: 'usage.recorded'
      readonly sample: {
        readonly model?: string
        readonly inputTokens?: number
        readonly outputTokens?: number
        readonly cachedTokens?: number
        readonly cost?: number
        readonly at: string
      }
    })
  | (EphemeralBase & {
      readonly type: 'command.output'
      readonly text: string
      readonly tone: 'info' | 'warning' | 'error' | 'success'
    })

export type AgentEventType = AgentEvent['type']
export type CommittedAgentEvent = Extract<AgentEvent, { durability: 'committed' }>
export type EphemeralAgentEvent = Extract<AgentEvent, { durability: 'ephemeral' }>
export type ItemEvent = Extract<AgentEvent, { type: 'item.started' | 'item.completed' | 'item.failed' }>

const envelope = {
  schema: z.number().int().positive(),
  at: z.string(),
  threadId: z.string().optional(),
  agentId: z.string().optional(),
  runId: z.string().optional(),
  itemId: z.string().optional(),
  seq: z.number().int().nonnegative().optional(),
  ompRef: ompRefSchema.optional(),
}
const committed = { durability: z.literal('committed') }
const ephemeral = { durability: z.literal('ephemeral') }

export const agentEventSchema = z.discriminatedUnion('type', [
  z.object({
    ...envelope,
    ...committed,
    type: z.literal('thread.titled'),
    title: z.string(),
    source: z.enum(['auto', 'user']),
  }),
  z.object({
    ...envelope,
    ...committed,
    type: z.literal('thread.forked'),
    parentThreadId: z.string(),
    fromRunId: z.string().optional(),
  }),
  z.object({ ...envelope, ...committed, type: z.literal('thread.archived') }),
  z.object({ ...envelope, ...committed, type: z.literal('run.queued'), run: turnHeaderSchema }),
  z.object({ ...envelope, ...committed, type: z.literal('run.started'), run: turnHeaderSchema }),
  z.object({ ...envelope, ...committed, type: z.literal('run.input_enqueued'), prompt: transcriptPromptSchema }),
  z.object({ ...envelope, ...committed, type: z.literal('run.input_withdrawn'), prompt: transcriptPromptSchema }),
  z.object({ ...envelope, ...committed, type: z.literal('run.input_consumed'), prompt: transcriptPromptSchema }),
  z.object({ ...envelope, ...committed, type: z.literal('run.input_dropped'), prompt: transcriptPromptSchema }),
  z.object({
    ...envelope,
    ...committed,
    type: z.literal('run.completed'),
    runId: z.string(),
    outcome: z.enum(['completed', 'failed', 'cancelled', 'interrupted']),
    endedAt: z.string().optional(),
    usage: turnHeaderSchema.shape.usage.optional(),
    durationMs: z.number().optional(),
    error: z.string().optional(),
  }),
  z.object({ ...envelope, ...committed, type: z.literal('step.started'), turnId: z.string(), step: stepHeaderSchema }),
  z.object({ ...envelope, ...committed, type: z.literal('step.retrying'), turnId: z.string(), step: stepHeaderSchema }),
  z.object({
    ...envelope,
    ...committed,
    type: z.literal('step.completed'),
    turnId: z.string(),
    step: stepHeaderSchema,
  }),
  z.object({
    ...envelope,
    ...committed,
    type: z.literal('item.started'),
    turnId: z.string(),
    stepId: z.string(),
    frame: transcriptFrameSchema,
  }),
  z.object({
    ...envelope,
    ...committed,
    type: z.literal('item.completed'),
    turnId: z.string(),
    stepId: z.string(),
    frame: transcriptFrameSchema,
  }),
  z.object({
    ...envelope,
    ...committed,
    type: z.literal('item.failed'),
    turnId: z.string(),
    stepId: z.string(),
    frame: transcriptFrameSchema,
  }),
  z.object({
    ...envelope,
    ...ephemeral,
    type: z.literal('item.delta'),
    turnId: z.string(),
    stepId: z.string(),
    frameId: z.string(),
    channel: z.enum(['text', 'thinking', 'tool_input', 'tool_output', 'progress']),
    offset: z.number().int().nonnegative().optional(),
    text: z.string().optional(),
    data: z.unknown().optional(),
  }),
  z.object({ ...envelope, ...committed, type: z.literal('item.removed'), ids: z.array(z.string()) }),
  z.object({
    ...envelope,
    ...committed,
    type: z.literal('interaction.requested'),
    interaction: interactionSchema,
  }),
  z.object({
    ...envelope,
    ...committed,
    type: z.literal('interaction.resolved'),
    interaction: interactionSchema,
  }),
  z.object({
    ...envelope,
    ...committed,
    type: z.literal('context.compacted'),
    item: transcriptMarkerSchema,
    beforeTurn: z.number().int().optional(),
  }),
  z.object({
    ...envelope,
    ...committed,
    type: z.literal('marker.raised'),
    item: transcriptMarkerSchema,
    beforeTurn: z.number().int().optional(),
  }),
  z.object({
    ...envelope,
    ...committed,
    type: z.literal('task.linked'),
    item: transcriptTaskRefSchema,
    beforeTurn: z.number().int().optional(),
  }),
  z.object({ ...envelope, ...committed, type: z.literal('task.started'), task: transcriptTaskSchema }),
  z.object({ ...envelope, ...committed, type: z.literal('task.finished'), task: transcriptTaskSchema }),
  z.object({
    ...envelope,
    ...ephemeral,
    type: z.literal('task.output'),
    taskId: z.string(),
    offset: z.number().int().nonnegative().optional(),
    text: z.string(),
  }),
  z.object({ ...envelope, ...committed, type: z.literal('attachment.added'), attachment: attachmentSchema }),
  z.object({
    ...envelope,
    ...committed,
    type: z.literal('todo.updated'),
    todo: z.object({
      todoId: z.string(),
      items: z.array(z.object({ title: z.string(), status: z.enum(['pending', 'in_progress', 'done']) })),
      updatedAt: z.string().optional(),
    }),
  }),
  z.object({ ...envelope, ...committed, type: z.literal('prompt.updated'), prompt: transcriptPromptSchema }),
  z.object({ ...envelope, ...committed, type: z.literal('agent.updated'), meta: transcriptMetaMergeSchema }),
  z.object({
    ...envelope,
    ...committed,
    type: z.literal('notice.raised'),
    turnId: z.string(),
    stepId: z.string(),
    frame: noticeFrameSchema,
  }),
  z.object({
    ...envelope,
    ...committed,
    type: z.literal('checkpoint.created'),
    checkpointId: z.string(),
    workspaceRoot: z.string(),
    label: z.string().optional(),
    reason: z.enum(['turn_start', 'turn_end', 'step', 'manual', 'revert']),
  }),
  z.object({
    ...envelope,
    ...committed,
    type: z.literal('policy.decided'),
    toolName: z.string(),
    category: z.string(),
    action: z.enum(['allow', 'ask', 'deny']),
    rule: z.string(),
    reason: z.string(),
    preset: z.string(),
    risk: z.enum(['none', 'low', 'medium', 'high']).optional(),
    workspaceRoot: z.string().optional(),
    toolCallId: z.string().optional(),
  }),
  z.object({
    ...envelope,
    ...committed,
    type: z.literal('policy.granted'),
    toolName: z.string(),
    grantId: z.string(),
    sessionKey: z.string(),
    expiresAt: z.number().int(),
  }),
  z.object({
    ...envelope,
    ...committed,
    type: z.literal('policy.revoked'),
    grantId: z.string(),
    toolName: z.string().optional(),
    sessionKey: z.string().optional(),
    removed: z.boolean(),
  }),
  z.object({
    ...envelope,
    ...committed,
    type: z.literal('usage.recorded'),
    sample: z.object({
      model: z.string().optional(),
      inputTokens: z.number().optional(),
      outputTokens: z.number().optional(),
      cachedTokens: z.number().optional(),
      cost: z.number().optional(),
      at: z.string(),
    }),
  }),
  z.object({
    ...envelope,
    ...ephemeral,
    type: z.literal('command.output'),
    text: z.string(),
    tone: z.enum(['info', 'warning', 'error', 'success']),
  }),
]) as unknown as z.ZodType<AgentEvent>

/** 状态快照 + 实时覆盖的分页载荷（P1 传输用；P2 换成 Journal 快照） */
export const threadSnapshotSchema: z.ZodType<ThreadSnapshot> =
  agentTranscriptSnapshotSchema as unknown as z.ZodType<ThreadSnapshot>
export type ThreadSnapshot = AgentTranscriptSnapshot

export function isCommitted(event: AgentEvent): event is CommittedAgentEvent {
  return event.durability === 'committed'
}

export function isEphemeral(event: AgentEvent): event is EphemeralAgentEvent {
  return event.durability === 'ephemeral'
}

/* 编译期断言：手写事件里的 StepHeader 与 schema 的 step 头同形 */
const _stepHeaderCheck: (step: StepHeader) => z.infer<typeof stepHeaderSchema> = (step) => step
void _stepHeaderCheck
