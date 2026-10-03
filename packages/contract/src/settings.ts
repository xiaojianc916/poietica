import type { commands } from './generated/ipc-bindings'

export type { AppSettings, Problem, SettingsWriteResult } from './generated/ipc-bindings'
export type ModelCatalogWire = Awaited<ReturnType<typeof commands.agentModelCatalog>>
/** agent 自己那份设置目录（正文以它的设置注册表为产地，见 ADR 0018）。 */
export type AgentSettingsCatalogWire = Awaited<ReturnType<typeof commands.agentSettingsCatalog>>
export type AgentSettingEntryWire = AgentSettingsCatalogWire['settings'][number]
