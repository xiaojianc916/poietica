import type { commands } from './generated/ipc-bindings'

export type {
  AgentConfigSnapshot as AgentConfigRecord,
  AgentInstallStatus,
  AppSettings,
  CustomAgentCatalog,
  CustomAgentFile,
  CustomAgentRemoveRequest,
  CustomAgentSaveRequest,
  Problem,
  SettingsWriteResult,
} from './generated/ipc-bindings'
export type ModelCatalogWire = Awaited<ReturnType<typeof commands.agentModelCatalog>>
