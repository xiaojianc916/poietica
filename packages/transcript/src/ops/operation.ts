import type { TranscriptAttachment } from '../model/attachment'
import type { TranscriptFrame } from '../model/frame'
import type { AgentId, FrameId, StepId, TaskId, TurnId } from '../model/ids'
import type { TranscriptInteraction } from '../model/interaction'
import type { TranscriptItem, TranscriptMarker, TranscriptTaskRef } from '../model/item'
import type { TranscriptMeta, TranscriptMetaMerge } from '../model/meta'
import type { TranscriptPrompt } from '../model/prompt'
import type { TranscriptTask } from '../model/task'
import type { TranscriptTodo } from '../model/todo'
import type { TranscriptStep, TranscriptTurn } from '../model/turn'

export type TurnHeader = Omit<TranscriptTurn, 'steps'>
export type StepHeader = Omit<TranscriptStep, 'frames'>

export interface ResetOp {
  readonly op: 'reset'
  readonly agentId: AgentId
  readonly snapshot: AgentTranscriptSnapshot
}

export interface TurnUpsertOp {
  readonly op: 'turn.upsert'
  readonly turn: TurnHeader
}

export interface StepUpsertOp {
  readonly op: 'step.upsert'
  readonly turnId: TurnId
  readonly step: StepHeader
}

export interface FrameUpsertOp {
  readonly op: 'frame.upsert'
  readonly turnId: TurnId
  readonly stepId: StepId
  readonly frame: TranscriptFrame
}

export type AppendTarget =
  | {
      readonly type: 'frame'
      readonly turnId: TurnId
      readonly stepId: StepId
      readonly frameId: FrameId
    }
  | { readonly type: 'task'; readonly taskId: TaskId }

export interface AppendOp {
  readonly op: 'append'
  readonly target: AppendTarget
  readonly offset: number
  readonly text: string
}

export interface MarkerUpsertOp {
  readonly op: 'marker.upsert'
  readonly item: TranscriptMarker
  readonly beforeTurn?: number
}

export interface TaskRefUpsertOp {
  readonly op: 'taskref.upsert'
  readonly item: TranscriptTaskRef
  readonly beforeTurn?: number
}

export interface TaskUpsertOp {
  readonly op: 'task.upsert'
  readonly task: TranscriptTask
}

export interface InteractionUpsertOp {
  readonly op: 'interaction.upsert'
  readonly interaction: TranscriptInteraction
}

export interface AttachmentUpsertOp {
  readonly op: 'attachment.upsert'
  readonly attachment: TranscriptAttachment
}

export interface TodoUpsertOp {
  readonly op: 'todo.upsert'
  readonly todo: TranscriptTodo
}

export interface PromptUpsertOp {
  readonly op: 'prompt.upsert'
  readonly prompt: TranscriptPrompt
}

export interface MetaMergeOp {
  readonly op: 'meta.merge'
  readonly meta: TranscriptMetaMerge
}

export interface ItemsRemoveOp {
  readonly op: 'items.remove'
  readonly ids: readonly string[]
}

export type TranscriptOperation =
  | ResetOp
  | TurnUpsertOp
  | StepUpsertOp
  | FrameUpsertOp
  | AppendOp
  | MarkerUpsertOp
  | TaskRefUpsertOp
  | TaskUpsertOp
  | InteractionUpsertOp
  | AttachmentUpsertOp
  | TodoUpsertOp
  | PromptUpsertOp
  | MetaMergeOp
  | ItemsRemoveOp

/**
 * 一轮在「轮次目录」里的一格：整条对话的定义域，不随加载了几页伸缩。
 * 只有头页（beforeTurn 缺席）带它，且只列人话开的轮（目标续跑轮不进目录，与界面 outline 同一判据）。
 * 题面与回复是截断过的预览：正文仍以分页读到的 turn 为准。
 */
export interface TurnOutlineEntry {
  readonly turnId: TurnId
  readonly ordinal: number
  readonly prompt: string
  readonly reply?: string
}

export interface AgentTranscriptSnapshot {
  readonly items: readonly TranscriptItem[]
  readonly tasks: readonly TranscriptTask[]
  readonly interactions: readonly TranscriptInteraction[]
  readonly attachments: readonly TranscriptAttachment[]
  readonly todos: readonly TranscriptTodo[]
  readonly prompts: readonly TranscriptPrompt[]
  readonly meta: TranscriptMeta
  readonly hasMoreOlder?: boolean
  /** 整条对话的轮次目录；缺席 = 引擎没给（旧引擎、子代理空页），界面退回「已加载的轮」。 */
  readonly outline?: readonly TurnOutlineEntry[]
}
