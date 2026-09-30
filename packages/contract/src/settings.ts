import type { commands } from './generated/ipc-bindings'

export type {
  AgentConfigSnapshot as AgentConfigRecord,
  AgentInstallStatus,
  AppSettings,
  Problem,
  SettingsWriteResult,
} from './generated/ipc-bindings'
export type ModelCatalogWire = Awaited<ReturnType<typeof commands.agentModelCatalog>>
/** agent 自己那份设置目录（正文以它的 settings-schema 为产地，见 ADR 0018）。 */
export type AgentSettingsCatalogWire = Awaited<ReturnType<typeof commands.agentSettingsCatalog>>
export type AgentSettingEntryWire = AgentSettingsCatalogWire['settings'][number]
