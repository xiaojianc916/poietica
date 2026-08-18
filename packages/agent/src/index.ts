/*
 * 这个包的唯一出口。
 *
 * timeline/ 把 kap 事件投影成可渲染的时间线：纯函数，没有 React，能在 Node 里
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
  DEFAULT_WORKSPACE_ID,
  groupByWorkspace,
  permissionControlOf,
  permissionPostureOf,
  permissionPosturesOf,
  SessionControlsStore,
  shorten,
  ThreadsStore,
  TranscriptStore,
  workspaceIdOf,
  workspaceNameOf,
} from './session'
export type {
  AgentTextItem,
  AgentThoughtItem,
  ConversationTurn,
  ErrorItem,
  FeedRow,
  MessageImage,
  PermissionItem,
  PlanItem,
  TimelineItem,
  TimelineItemId,
  TimelineState,
  ToolCallTimelineItem,
  TurnSpan,
  UserMessageItem,
} from './timeline'
export {
  appendLocalError,
  appendUserMessage,
  applyRunEvent,
  applyRunEvents,
  createTimelineState,
  pendingPermission,
  pendingPermissionCall,
  pendingPermissionCount,
  replayRunEvents,
  replayThreadEvents,
  selectFeedRows,
  selectIsBusy,
  selectIsWaiting,
  selectTurns,
} from './timeline'
