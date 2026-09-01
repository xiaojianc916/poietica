/* Domain-owned vocabulary. The native bridge translates generated wire DTOs at the process boundary. */
export type AgentCapability = {
  id: string
  pluginId: string | null
  label: string
  supported: boolean
  state: AgentCapabilityState
  install: AgentCapabilityInstall
}
export type AgentCapabilityInstall = {
  running: boolean
  step: string | null
  percent: number | null
  error: string | null
}
export type AgentCapabilityState = 'notInstalled' | 'partial' | 'ready' | 'unsupported'
export type AgentSkill = {
  id: string
  name: string
  description: string
  source: string
  path: string
  project: string | null
  projectPath: string | null
  document: string | null
  directory: string | null
  enabled: boolean
  loaded: boolean
  kind: string | null
  disableModelInvocation: boolean | null
  supportingFiles: number | null
  totalBytes: number | null
  modifiedAt: number | null
}
export type EnvironmentFile = { location: string; contents: string | null }
export type ForeignPluginInventory = { location: string; plugins: ForeignPluginRecord[] }
export type ForeignPluginRecord = {
  pluginId: string
  /**
   * 人当初给命令行的那一串地址。缺席表示那条记录没记，导入因此没有起点。
   */
  originalSource: string | null
}
export type PluginCommitRequest = {
  stagingId: string
  /**
   * 渲染层解码清单之后判定的标识符，也就是官方记录里的 id。
   */
  pluginId: string
  /**
   * 取用时用的那一段子目录。认领的是清单所在的那一层，与取用时是同一层。
   */
  subdirectory: string | null
  /**
   * 官方 InstalledRecord.source 的三个取值之一：local-path / zip-url / github。
   */
  source: string
  /**
   * 人当初给的那一串地址。官方拿它显示来源，我们拿它回查目录里的背书。
   */
  originalSource: string | null
  /**
   * ISO-8601。时钟在领域层，不在这里 —— 原生侧没有理由持有第二个时间源。
   */
  installedAt: string
}
export type PluginFetch =
  | { kind: 'directory'; path: string }
  | { kind: 'archive'; url: string; subdirectory: string | null }
export type PluginPayload = {
  pluginId: string
  manifestJson: string
  enabled: boolean
  installedAt: string | null
  source: string
  originalSource: string | null
  disabledMcpServers: string[]
}
export type PluginStaged = {
  stagingId: string
  /**
   * 清单原文。这一层不解析它。
   */
  manifestJson: string
}
export type SkillCommitRequest = { stagingId: string; name: string; subdirectory: string | null }
export type SkillRecord = {
  name: string
  enabled: boolean
  document: string
  path: string
  supportingFiles: number
  totalBytes: number
  modifiedAt: number | null
}
export type SkillStaged = { stagingId: string; skillMd: string }
