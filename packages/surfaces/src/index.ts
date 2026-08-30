/*
 * 六个领域的表面视图，一个包。域边界是包内的目录边界：各域互不引用
 * （原先同环禁边的那条规矩，平移成目录之间的规矩），唯一消费方是
 * apps/desktop 组合根。
 */

export { AutomationsSurface } from './automation/automations-surface'
export type { DockPaneOffer } from './browser/browser-menu'
export type { DockPaneRenderer, DockPaneRenderers } from './browser/browser-panel'
export { BrowserPanel } from './browser/browser-panel'
export type { DockPaneView } from './browser/browser-tab-strip'
export type { AttachmentIntake, ComposerAsset } from './conversation/composer/attachment-intake'
export { AttachmentIntakeContext } from './conversation/composer/attachment-intake'
export { ComposerDrafts, ComposerDraftsContext } from './conversation/composer/composer-drafts'
export type { PromptInputHandle } from './conversation/composer/prompt-input'
export { GoalIsland } from './conversation/goal/goal-island'
export {
  AgentControlsContext,
  useAgentControls,
} from './conversation/session/agent-controls-context'
export {
  SessionControlsContext,
  useSessionControlsActions,
  useThreadSelectorFailure,
  useThreadSelectors,
  useThreadUsage,
} from './conversation/session/session-controls-context'
export { TranscriptsContext, useTranscripts } from './conversation/session/transcripts-context'
export { useAssistantSession } from './conversation/session/use-assistant-session'
export { useRunningThreads } from './conversation/session/use-running-threads'
export { AssistantSurface } from './conversation/surface/assistant-surface'
export { AssistantThreadList } from './conversation/threads/assistant-thread-list'
export type { GitBranchPickerProps } from './conversation/threads/git-branch-picker'
export type { WorkspacePickerProps } from './conversation/threads/workspace-picker'
export {
  DelegateChannelContext,
  useDelegateChannel,
} from './conversation/timeline/delegate-channel-context'
export {
  DelegateChannelIcon,
  DelegateChannelPane,
  useDelegateChannelNames,
} from './conversation/timeline/delegate-channel-view'
export { PluginsSurface } from './extension/plugins-surface'
export { ReviewPane, type ReviewPaneProps } from './review/review-pane'
export { PersonalizationSurface } from './settings/personalization-surface'
export {
  SettingsContentRegion,
  SettingsNavigationRegion,
  SettingsProvider,
  type SettingsProviderProps,
} from './settings/surface/settings-surface'
