import type { commands } from './generated/ipc-bindings'

export type {
  AgentConfigSnapshot as AgentConfigRecord,
  AgentInstallStatus,
  AppearanceSettings,
  AppSettings,
  CustomAgentCatalog,
  CustomAgentFile,
  CustomAgentRemoveRequest,
  CustomAgentSaveRequest,
  Density,
  GeneralSettings,
  ModelPickerSettings,
  PrivacySettings,
  Problem,
  SettingsWriteResult,
  ThemePreference,
} from './generated/ipc-bindings'
export type ModelCatalogWire = Awaited<ReturnType<typeof commands.agentModelCatalog>>
