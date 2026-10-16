// 显式罗列而非 export *：线上契约在 contract/，消费侧读法在 model/，通配会藏起同名同形的分叉。

// —— 模型与 op（src/model、src/ops）——
export type { TranscriptAttachment } from './model/attachment'
export type { TranscriptFrame, TranscriptSkillActivation } from './model/frame'
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
} from './model/ids'
export { frameId, stepId, turnId, turnOrdinal } from './model/ids'
export type {
  ApprovalInteraction,
  ApprovalRequest,
  ApprovalResponse,
  InteractionKind,
  InteractionQuestion,
  InteractionQuestionOption,
  InteractionState,
  PlanInteraction,
  PlanRequest,
  PlanResponse,
  QuestionAnswerValue,
  QuestionInteraction,
  QuestionRequest,
  QuestionResponse,
  TranscriptInteraction,
} from './model/interaction'
export type { TranscriptItem, TranscriptMarker, TranscriptTaskRef } from './model/item'
export { itemId } from './model/item'
export type { TranscriptMeta, TranscriptMetaMerge } from './model/meta'
export type { TranscriptPrompt } from './model/prompt'
export type { TranscriptTask } from './model/task'
export type { TranscriptTodo } from './model/todo'
export type { SystemTrigger, TranscriptStep, TranscriptTurn, TranscriptUsage, TurnOrigin } from './model/turn'
export { applyOperation, EMPTY_AGENT_STATE } from './ops/apply'
export type {
  AgentTranscriptSnapshot,
  AppendTarget,
  StepHeader,
  TranscriptOperation,
  TurnHeader,
} from './ops/operation'
// —— 本包新增：三个进程共用的高层 API ——
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
  transcriptOperationSchema,
  transcriptPageSchema,
} from './timeline'
