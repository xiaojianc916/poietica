/*
 * 这个包的唯一出口。
 *
 * timeline/ 把 kap 事件投影成可渲染的时间线，interjection/ 持有待插话消息的顺序：
 * 纯函数与纯状态机，没有 React，能在 Node 里
 * 直接单测。session/ 在它上面管线程、转录、可调项与能力表。两段是同一条管线的
 * 前后半，边界留在包内的目录上；整个包不认识 React —— hooks 与 Context 归
 * @poietica/agent-ui，这条边由 framework-free-domain 守着。
 */

export type { Interjection, OutboxPort, OutboxState, Said } from './interjection'
export { InterjectionOutbox } from './interjection'
export type {
  AgentCapabilityOptions,
  AgentControls,
  CapabilityFailureReport,
  EarlierFrames,
  PermissionPosture,
  SessionControlsFailureReport,
  ThreadListItem,
  ThreadsList,
  ThreadsStoreOptions,
  ThreadWorkspaceGroup,
  ThreadWorkspaceList,
  Transcript,
  TranscriptSink,
  TranscriptStoreOptions,
} from './session'
export {
  AgentCapabilityStore,
  DEFAULT_WORKSPACE_ID,
  describeFailure,
  groupByWorkspace,
  isPermissionPostureChange,
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
  InflightPromptItem,
  LinkTimelineItem,
  MessageImage,
  PermissionItem,
  PlanItem,
  Presentation,
  QuestionTimelineItem,
  ReplyActionPlan,
  TimelineItem,
  TimelineItemId,
  TimelineState,
  ToolCallTimelineItem,
  ToolGroupKind,
  ToolGroupPlan,
  TurnPage,
  TurnSealPlan,
  TurnSpan,
  UserMessageItem,
} from './timeline'
export {
  activeScope,
  appendLocalError,
  appendUserMessage,
  applyRunEvent,
  applyRunEvents,
  channelNameOf,
  completedUnits,
  createTimelineState,
  delegateKey,
  delegationOf,
  inflightPromptId,
  isDelegateKey,
  isDelegation,
  liveMemberOf,
  partitionByAgent,
  pendingPermission,
  pendingPermissionCall,
  pendingPermissionCount,
  pendingQuestion,
  prependThreadEvents,
  replayRunEvents,
  replayThreadEvents,
  runningDelegations,
  selectIsBusy,
  selectPresentation,
} from './timeline'
