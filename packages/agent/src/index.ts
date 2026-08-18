/*
 * 这个包的唯一出口。
 *
 * timeline/ 把 ACP 事件投影成可渲染的时间线：纯函数，没有 React，能在 Node 里
 * 直接单测。session/ 在它上面管线程、转录、可调项与能力表。两段是同一条管线的
 * 前后半，边界留在包内的目录上；整个包不认识 React —— hooks 与 Context 归
 * @poietica/agent-ui，这条边由 framework-free-domain 守着。
 */

export type {
  AgentCapabilityOptions,
  AgentControls,
  CapabilityFailureReport,
  PermissionPosture,
  SessionControlsFailureReport,
  ThreadListItem,
  ThreadsList,
  ThreadsStoreOptions,
  ThreadWorkspaceGroup,
  ThreadWorkspaceList,
  Transcript,
  TranscriptSink,
} from './session'
export {
  AgentCapabilityStore,
  AgentThoughtItem,
  ConversationTurn,
  DEFAULT_WORKSPACE_ID,
  ErrorItem,
  FeedRow,
  groupByWorkspace,
  MessageImage,
  PermissionItem,
  PlanItem,
  pendingPermissionCall,
  permissionControlOf,
  permissionPostureOf,
  permissionPosturesOf,
  SessionControlsStore,
  shorten,
  ThreadsStore,
  TimelineItem,
  TimelineItemId,
  TimelineState,
  ToolCallTimelineItem,
  TranscriptStore,
  TurnSpan,
  UserMessageItem,
  workspaceIdOf,
  workspaceNameOf,
} from './session'
export type { AgentTextItem } from './timeline'
export {
  appendLocalError,
  appendUserMessage,
  applyRunEvent,
  applyRunEvents,
  createTimelineState,
  pendingPermission,
  pendingPermissionCount,
  replayRunEvents,
  replayThreadEvents,
  selectFeedRows,
  selectIsBusy,
  selectIsWaiting,
  selectTurns,
} from './timeline'
