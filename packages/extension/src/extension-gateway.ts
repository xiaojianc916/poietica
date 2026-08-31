import type {
  EnvironmentFile,
  ForeignPluginInventory,
  PluginCommitRequest,
  PluginFetch,
  PluginPayload,
  PluginStaged,
  SkillCommitRequest,
  SkillRecord,
  SkillStaged,
} from '@poietica/contract'

/*
 * 扩展与技能账本的端口：领域不认识 IPC，由组合根注入 native-bridge 的实现。
 *
 * DTO 不在这里声明 —— 产地是 Rust，经由生成绑定过来。这一层只把「需要宿主提供
 * 哪些动作」摆成一份可命名的词汇，store 之外谁也不许直连 native-bridge。
 */

export interface ExtensionGateway {
  /** agent 账本里的插件清单。开关与记录同读。 */
  listPlugins(): Promise<PluginPayload[]>
  stagePlugin(fetch: PluginFetch): Promise<PluginStaged>
  commitPlugin(request: PluginCommitRequest): Promise<void>
  discardStagedPlugin(stagingId: string): Promise<void>
  removePlugin(pluginId: string): Promise<void>
  setPluginEnabled(pluginId: string, enabled: boolean): Promise<void>
  setPluginMcpEnabled(pluginId: string, server: string, enabled: boolean): Promise<void>
  /** 上一次拉下来、存在盘上的市场目录。null 表示从来没取过。 */
  readPluginCatalog(): Promise<string | null>
  refreshPluginCatalog(url: string): Promise<string>
  /** 用户自己家里那本账，只读。null 表示这台机器没有第二本账。 */
  listForeignPlugins(): Promise<ForeignPluginInventory | null>
  listSkills(): Promise<SkillRecord[]>
  stageSkill(fetch: PluginFetch): Promise<SkillStaged>
  commitSkill(request: SkillCommitRequest): Promise<void>
  discardStagedSkill(stagingId: string): Promise<void>
  trashSkill(name: string): Promise<void>
  setSkillEnabled(name: string, enabled: boolean): Promise<void>
  /** 这个 agent 自己那份 mcp.json 的读与比对写。 */
  readEnvironmentMcpConfig(): Promise<EnvironmentFile>
  writeEnvironmentMcpConfig(
    expectedContents: string | null,
    contents: string,
  ): Promise<EnvironmentFile>
}
