/*
 * 包的公开面。逐个具名导出：对外承诺了什么，读这一份文件就够。
 * 组件住在 @poietica/surfaces 的 settings/；这里只有设置领域与端口。
 */

export type {
  AgentConfigSnapshot,
  AgentConfigStore,
  AgentInstallStatus,
  ProviderKeyProbe,
} from './agent-config-store'
export type {
  CustomAgentDraft,
  DelegationMode,
  ModelPreference,
  ToolMode,
} from './custom-agents/agent-document'
export type {
  CustomAgentCatalog,
  CustomAgentFile,
  CustomAgentRemoveRequest,
  CustomAgentSaveRequest,
  CustomAgentStore,
} from './custom-agents/custom-agent-store'
export { PersonalizationStore } from './custom-agents/personalization-store'
export type { KeybindingCatalog, KeybindingEntry } from './keymap/keybinding-catalog'
export type { AppSettings } from './settings'
export { createSettingsSession, type SettingsOperation } from './settings-session'
export type { SettingsStore } from './settings-store'
