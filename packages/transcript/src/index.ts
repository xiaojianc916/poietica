// 显式罗列而非 export *：线上契约在 upstream/contract，消费侧读法在 upstream/model，通配会藏起同名同形的分叉。

// —— 本包新增：三个进程共用的高层 API（05 页 §12.1）——
export {
  applyOps,
  emptyTimeline,
  oldestTurnId,
  pageFromState,
  prependOlder,
  stateFromPage,
  type TimelineState,
  TranscriptGapError,
  type TranscriptPage,
  transcriptPageSchema,
} from './timeline'
// —— 上游（src/upstream/，原样迁移自 legacy packages/transcript）——
export {
  agentTranscriptSnapshotSchema,
  appendTargetSchema,
  transcriptItemSchema,
  transcriptMetaSchema,
  transcriptOperationSchema,
  transcriptOpsCatchupResponseSchema,
  transcriptOpsPayloadSchema,
  transcriptResetPayloadSchema,
  transcriptResponseSchema,
} from './upstream/contract/schema'
export { foldWireRecordFacts } from './upstream/history/foldFacts'
export { groupMessagesIntoSnapshot } from './upstream/history/groupTurns'
export type { TranscriptAttachment } from './upstream/model/attachment'
export type { TranscriptFrame } from './upstream/model/frame'
export type {
  AgentId,
  AttachmentId,
  FrameId,
  InteractionId,
  PromptId,
  StepId,
  TaskId,
  TodoId,
  TurnId,
} from './upstream/model/ids'
export { compareTurnIds, frameId, stepId, turnId, turnOrdinal } from './upstream/model/ids'
export type { TranscriptInteraction } from './upstream/model/interaction'
export type { TranscriptItem, TranscriptMarker, TranscriptTaskRef } from './upstream/model/item'
export { itemId } from './upstream/model/item'
export type { TranscriptMeta, TranscriptMetaMerge } from './upstream/model/meta'
export type { TranscriptPrompt } from './upstream/model/prompt'
export type { TranscriptTask } from './upstream/model/task'
export type { TranscriptTodo } from './upstream/model/todo'
export type { TranscriptStep, TranscriptTurn, TranscriptUsage } from './upstream/model/turn'
export { applyOperation, EMPTY_AGENT_STATE } from './upstream/ops/apply'
export type {
  AgentTranscriptSnapshot,
  AppendTarget,
  StepHeader,
  TranscriptOperation,
  TurnHeader,
} from './upstream/ops/operation'
