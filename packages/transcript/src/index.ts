// 显式罗列而非 export *：线上契约在 contract/，消费侧读法在 model/，通配会藏起同名同形的分叉。

export type {
  TranscriptEvent,
  TranscriptEventType,
  TranscriptOpsEvent,
  TranscriptResetEvent,
} from './contract/events'
export {
  TRANSCRIPT_EVENT_TYPES,
  transcriptEventSchema,
  transcriptOpsEventSchema,
  transcriptResetEventSchema,
} from './contract/events'

export type {
  DaemonFileRef,
  MediaPathTagKind,
  MediaPathTagMatch,
  MediaRefPart,
} from './contract/mediaRef'
export {
  daemonFileRefFromPairingPart,
  matchMediaPathTagText,
  parseDaemonFileRef,
  parseDaemonFileRefFileId,
} from './contract/mediaRef'

export {
  projectTranscriptUserOrigin,
} from './contract/origin'

export type {
  TranscriptSubscribeV2Payload,
} from './contract/schema'
export {
  agentDescriptorSchema,
  agentIdSchema,
  agentPhaseMetaSchema,
  agentRefSchema,
  agentStatusMetaSchema,
  agentTranscriptSnapshotSchema,
  agentUsageMetaSchema,
  appendTargetSchema,
  attachmentSchema,
  frameIdSchema,
  goalMetaSchema,
  interactionSchema,
  isPlainAgentId,
  modesMetaMergeSchema,
  modesMetaSchema,
  noticeFrameSchema,
  stepHeaderSchema,
  stepIdSchema,
  stepRetrySchema,
  stepStateSchema,
  stepTimingSchema,
  stepUsageSchema,
  taskIdSchema,
  textFrameSchema,
  thinkingFrameSchema,
  todoItemSchema,
  todoSchema,
  toolCallFrameSchema,
  toolFrameProgressSchema,
  transcriptFrameSchema,
  transcriptGradeSchema,
  transcriptGradeSpecSchema,
  transcriptItemSchema,
  transcriptMarkerSchema,
  transcriptMetaMergeSchema,
  transcriptMetaSchema,
  transcriptOpBatchSchema,
  transcriptOperationSchema,
  transcriptOpsCatchupResponseSchema,
  transcriptOpsPayloadSchema,
  transcriptPlanEntrySchema,
  transcriptPlanResponseSchema,
  transcriptPlanReviewSchema,
  transcriptPromptSchema,
  transcriptQuerySchema,
  transcriptResetPayloadSchema,
  transcriptResponseSchema,
  transcriptSeqSchema,
  transcriptSkillActivationSchema,
  transcriptStepSchema,
  transcriptSubscribeV2PayloadSchema,
  transcriptTaskRefSchema,
  transcriptTaskSchema,
  transcriptTurnSchema,
  transcriptUsageSchema,
  transcriptUserMessageSchema,
  transcriptUserMessagesResponseSchema,
  transcriptUserOriginSchema,
  turnHeaderSchema,
  turnIdSchema,
  turnOriginSchema,
  turnStateSchema,
} from './contract/schema'

export {
  filterOpsForGrade,
  isAppendOnly,
  redactSnapshotForGrade,
} from './granularity/filterOps'

export type {
  TranscriptGrade,
  TranscriptGradeSpec,
} from './granularity/grade'
export {
  GRADE_RANK,
  detachGrades,
  gradeFor,
  needsResetOnTransition,
} from './granularity/grade'

export type {
  HistoryWireRecord,
} from './history/foldFacts'
export {
  foldWireRecordFacts,
} from './history/foldFacts'

export type {
  HistoryContentPart,
  HistoryMediaSource,
  HistoryMessage,
  HistoryToolCall,
} from './history/groupTurns'
export {
  groupMessagesIntoSnapshot,
} from './history/groupTurns'

export type {
  AttachmentSource,
  TranscriptAttachment,
} from './model/attachment'

export type {
  AgentRef,
  AssistantTextFrame,
  FrameRef,
  NoticeFrame,
  TextFrame,
  ThinkingFrame,
  ToolCallFrame,
  ToolFrameProgress,
  ToolFrameState,
  TranscriptFrame,
  TranscriptSkillActivation,
  TranscriptUserOrigin,
  UserTextFrame,
} from './model/frame'

export type {
  AgentId,
  AttachmentId,
  FrameId,
  InteractionId,
  ItemId,
  MarkerId,
  PromptId,
  StepId,
  TaskId,
  TaskRefId,
  TodoId,
  TurnId,
} from './model/ids'
export {
  compareTurnIds,
  frameId,
  stepId,
  turnId,
  turnOrdinal,
} from './model/ids'

export type {
  InteractionKind,
  InteractionState,
  TranscriptInteraction,
} from './model/interaction'

export type {
  MarkerKey,
  TranscriptItem,
  TranscriptMarker,
  TranscriptTaskRef,
} from './model/item'
export {
  KNOWN_MARKERS,
  itemId,
} from './model/item'

export type {
  ActivityMeta,
  AgentPhaseMeta,
  AgentStatusMeta,
  AgentUsageMeta,
  GoalMeta,
  GoalStatus,
  ModesMeta,
  ModesMetaMerge,
  TranscriptMeta,
  TranscriptMetaMerge,
  TurnEndReasonMeta,
} from './model/meta'

export type {
  TranscriptPrompt,
  TranscriptPromptStatus,
} from './model/prompt'

export type {
  TaskKind,
  TaskState,
  TranscriptTask,
} from './model/task'

export type {
  TodoItem,
  TodoStatus,
  TranscriptTodo,
} from './model/todo'

export type {
  StepRetry,
  StepState,
  StepTiming,
  StepUsage,
  TranscriptStep,
  TranscriptTurn,
  TranscriptUsage,
  TurnOrigin,
  TurnState,
} from './model/turn'

export type {
  AgentTranscriptSnapshot,
  AppendOp,
  AppendTarget,
  AppliedOps,
  AttachmentUpsertOp,
  FrameUpsertOp,
  InteractionUpsertOp,
  ItemsRemoveOp,
  MarkerUpsertOp,
  MetaMergeOp,
  PromptUpsertOp,
  ResetOp,
  StepHeader,
  StepUpsertOp,
  TaskRefUpsertOp,
  TaskUpsertOp,
  TodoUpsertOp,
  TranscriptChangeEvent,
  TranscriptOpBatch,
  TranscriptOperation,
  TurnHeader,
  TurnUpsertOp,
} from './ops/operation'

export type {
  TurnPage,
  TurnPageQuery,
} from './pagination/paginate'
export {
  paginateTurns,
} from './pagination/paginate'

export type {
  Disposable,
  TranscriptListener,
} from './store/agentTranscript'
export {
  AgentTranscript,
} from './store/agentTranscript'

export type {
  AgentDescriptor,
  RosterListener,
} from './store/transcriptStore'
export {
  TranscriptStore,
} from './store/transcriptStore'

export type { AgentState, ApplyResult } from './ops/apply'
export { appendAtOffset, applyOperation, EMPTY_AGENT_STATE } from './ops/apply'
