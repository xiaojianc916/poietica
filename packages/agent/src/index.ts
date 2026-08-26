/*
 * 这个包的唯一出口。
 *
 * timeline/ 把 kap 事件投影成可渲染的时间线，interjection/ 持有待插话消息的顺序：
 * 纯函数与纯状态机，没有 React，能在 Node 里
 * 直接单测。session/ 在它上面管线程、转录、可调项与能力表。两段是同一条管线的
 * 前后半，边界留在包内的目录上；整个包不认识 React —— hooks 与 Context 归
 * @poietica/agent-ui，这条边由 framework-free-domain 守着。
 */

export type { Interjection } from './interjection'
export { InterjectionOutbox } from './interjection'
export type {
  AgentControls,
  SessionControlsFailureReport,
  ThreadWorkspaceList,
  Transcript,
} from './session'
export {
  AgentCapabilityStore,
  describeFailure,
  groupByWorkspace,
  permissionControlOf,
  permissionPostureOf,
  permissionPosturesOf,
  SessionControlsStore,
  ThreadsStore,
  TranscriptStore,
} from './session'
export type {
  ConversationTurn,
  FeedRow,
  LinkTimelineItem,
  MessageImage,
  PermissionItem,
  PlanItem,
  Presentation,
  QuestionTimelineItem,
  TimelineState,
  ToolCallTimelineItem,
  ToolGroupPlan,
  TurnSealPlan,
} from './timeline'
export {
  activeScope,
  applyRunEvents,
  channelNameOf,
  delegateKey,
  delegationOf,
  inflightPromptId,
  isDelegation,
  liveMemberOf,
  pendingPermission,
  pendingPermissionCall,
  pendingPermissionCount,
  pendingQuestion,
  replayThreadEvents,
  selectIsBusy,
  selectPresentation,
} from './timeline'
