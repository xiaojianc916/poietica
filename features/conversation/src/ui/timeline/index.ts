/*
 * timeline 区：转录副本、视图模型与虚拟列表。区与区之间只能经本文件互相引用。
 */

export type { TranscriptSink } from './model/transcript-sink'
export { type PreparedThread, TranscriptStore } from './model/transcript-store'
export {
  type AssistantSession,
  useAssistantBackgroundTasks,
  useAssistantInteractions,
  useAssistantSession,
  useAssistantSubagents,
  useAssistantTimeline,
  useAssistantTodos,
} from './model/use-assistant-session'
export { SubagentTabsStore } from './subagent-tabs'
export { delegateCallsOf } from './timeline-queries'
export { type AgentControls, AgentControlsContext, useAgentControls } from './view/agent-controls-context'
export {
  DelegateChannelContext,
  type OpenDelegateChannel,
  useDelegateChannel,
  useOptionalDelegateChannel,
} from './view/delegate-channel-context'
export { subagentTitleOf } from './view/delegate-channel-view'
export { createSubagentDockTabs, openSubagentTab, SUBAGENT_PANEL_ID, SubagentDockPanel } from './view/subagent-dock'
export { TranscriptView } from './view/transcript-view'
