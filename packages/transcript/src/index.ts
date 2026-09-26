// 显式罗列而非 export *：线上契约在 contract/，消费侧读法在 model/，通配会藏起同名同形的分叉。

export {
  transcriptOperationSchema,
  transcriptOpsCatchupResponseSchema,
  transcriptOpsPayloadSchema,
  transcriptResetPayloadSchema,
  transcriptResponseSchema,
} from './contract/schema'

export {
  foldWireRecordFacts,
} from './history/foldFacts'

export {
  groupMessagesIntoSnapshot,
} from './history/groupTurns'

export type {
  TranscriptAttachment,
} from './model/attachment'

export type {
  TranscriptFrame,
} from './model/frame'

export {
  frameId,
  stepId,
  turnId,
} from './model/ids'

export type {
  TranscriptInteraction,
} from './model/interaction'

export type {
  TranscriptMarker,
} from './model/item'
export {
  itemId,
} from './model/item'

export type {
  TranscriptTask,
} from './model/task'

export type {
  TranscriptTurn,
} from './model/turn'

export type {
  AgentTranscriptSnapshot,
  TranscriptOperation,
} from './ops/operation'

export {
  AgentTranscript,
} from './store/agentTranscript'

export type {
  AgentDescriptor,
} from './store/transcriptStore'
export {
  TranscriptStore,
} from './store/transcriptStore'

export { applyOperation, EMPTY_AGENT_STATE } from './ops/apply'
