/*
 * 包的公开面。逐个具名导出：对外承诺了什么，读这一份文件就够。
 * 组件住在 @poietica/settings/ui；这里只有设置领域与端口。
 */

export type {
  AgentConfigSnapshot,
  AgentInstallStatus,
  AgentSettings,
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
export type {
  CatalogModel,
  CatalogProvider,
  ModelCatalogData,
  ModelCatalogOperation,
  ModelCatalogPort,
  ModelCatalogSnapshot,
  ModelDescriptor,
  ModelProvider,
  ProviderInput,
  ProviderModelInput,
  ProviderReplacement,
} from './model-catalog-store'
export { ModelCatalogStore } from './model-catalog-store'
export type { AppSettings } from './settings'
export { createSettingsSession, type SettingsOperation } from './settings-session'
export type { SettingsStore } from './settings-store'
