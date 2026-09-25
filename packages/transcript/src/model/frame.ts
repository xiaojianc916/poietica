import type { AgentId, AttachmentId, FrameId, InteractionId, TaskId, TodoId } from './ids'

export type { InteractionKind, InteractionState } from './interaction'

export type FrameRef = {
  readonly target: 'frame'
  readonly frameId: FrameId
}

export interface TranscriptSkillActivation {
  readonly skillName: string
  readonly skillArgs?: string
}

export interface TranscriptUserOrigin {
  readonly kind: 'user'
  readonly skillActivations?: readonly TranscriptSkillActivation[]
}

interface TextFrameBase {
  readonly kind: 'text'
  readonly frameId: FrameId
  readonly text: string
  readonly attachmentIds?: readonly AttachmentId[]
  readonly taskId?: TaskId
  readonly promptIds?: readonly string[]
}

export interface AssistantTextFrame extends TextFrameBase {
  readonly role: 'assistant'
  readonly origin?: never
}

export interface UserTextFrame extends TextFrameBase {
  readonly role: 'user'
  readonly origin?: TranscriptUserOrigin
}

export type TextFrame = AssistantTextFrame | UserTextFrame

export interface ThinkingFrame {
  readonly kind: 'thinking'
  readonly frameId: FrameId
  readonly text: string
}

export type ToolFrameState = 'running' | 'done' | 'error'

export interface ToolFrameProgress {
  readonly kind: 'stdout' | 'stderr' | 'progress' | 'status' | 'custom'
  readonly text?: string
  readonly percent?: number
  readonly customKind?: string
  readonly customData?: unknown
}

export interface AgentRef {
  readonly agentId: AgentId
  readonly role?: 'child' | 'member'
}

export interface ToolCallFrame {
  readonly kind: 'tool'
  readonly frameId: FrameId
  readonly toolCallId: string
  readonly name: string
  readonly state: ToolFrameState
  readonly input?: unknown
  /**
   * agent 自己写的那句话：这次调用打算做什么。
   *
   * omp 的 `tool_execution_start` 与 `ToolCall` 都带它（pi-wire 的 INTENT_FIELD，
   * 提示里叫 "concise intent"）——「Reading ADR 0052」「Checking kap-client drift」。
   * 它由模型自己写、比我们按参数猜得准，官方渲染器也优先用它当那一行。
   */
  readonly intent?: string
  readonly output?: unknown
  readonly error?: string
  readonly progress?: ToolFrameProgress
  readonly taskId?: TaskId
  readonly approvalId?: InteractionId
  readonly todoId?: TodoId
  readonly agentRefs?: readonly AgentRef[]
}

export interface NoticeFrame {
  readonly kind: 'notice'
  readonly frameId: FrameId
  readonly level: 'error' | 'warning' | 'info'
  readonly source?: string
  readonly message: string
  readonly detail?: unknown
}

export type TranscriptFrame = TextFrame | ThinkingFrame | ToolCallFrame | NoticeFrame
