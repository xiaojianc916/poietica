import type { BrowserRelayEndpoint } from './browser-relay'
import type { AgentEngine, EngineInfo } from './engine'
import type { McpPort, ModelsPort, PluginsPort, SessionFilesPort, SettingsPort, SkillsPort } from './ports'

/**
 * 按能力收窄的运行时门面（架构设计 §16.5）。
 *
 * Core 模块不再拿整个引擎对象：会话、模型、设置、扩展、浏览器各自一组，只能调用自己那一组。
 * 实现仍由 engine-omp 提供；P3 把这一层换成 ARP 的方法组时，消费方只改注入来源。
 */
export interface RuntimeServices {
  readonly info: EngineInfo
  readonly sessions: {
    readonly openSession: AgentEngine['openSession']
    readonly sessionFiles: SessionFilesPort
    readonly draftControls: AgentEngine['draftControls']
    readonly commandCatalog: AgentEngine['commandCatalog']
  }
  readonly models: ModelsPort
  readonly settings: SettingsPort
  readonly skills: SkillsPort
  readonly mcp: McpPort
  readonly plugins: PluginsPort
  readonly browser: {
    readonly relay: () => BrowserRelayEndpoint | null
  }
}
