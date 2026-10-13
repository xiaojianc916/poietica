import type { Disposable } from '@poietica/foundation'
import type { McpPort, ModelsPort, PluginsPort, SessionFilesPort, SettingsPort, SkillsPort } from './ports'
import type { EngineSession, OpenSessionSpec } from './session'
import type { EngineToolSpec } from './tools'
import type { Controls, ModelRef, Posture } from './values'

export interface EngineInfo {
  readonly name: 'omp'
  readonly version: string
}

/**
 * 草稿选择：入口页（还没有 threadId）画选择器要用的那几格。全部可选，缺席的由引擎填默认值
 * （模型用 modelRoles.default、思考档位用 defaultThinkingLevel、姿态用 auto-edit）。
 */
export interface DraftControlInit {
  readonly model?: ModelRef | null
  readonly thinking?: string | null
  readonly posture?: Posture
}

export interface AgentEngine {
  readonly info: EngineInfo
  /**
   * **只读**出一份草稿控件表：不开会话、不写设置、不碰任何文件。规则与会话里那份一致：可选模型来自
   * registry.getAvailable()，思考档位按当前模型给出（omp 的 Model.thinking.efforts，静态可得），默认姿态是 auto-edit。
   */
  draftControls(init?: DraftControlInit): Promise<Controls>
  /** 注册内置 agent 工具。必须在第一次 openSession 之前完成；之后调用抛 engine.tools_frozen。 */
  registerTool(spec: EngineToolSpec): Disposable
  /** 冻结工具表。core-kernel 在全部模块 setup 完成后调用一次。 */
  freezeTools(): void
  openSession(spec: OpenSessionSpec): Promise<EngineSession>
  readonly sessionFiles: SessionFilesPort
  readonly models: ModelsPort
  readonly settings: SettingsPort
  readonly skills: SkillsPort
  readonly mcp: McpPort
  readonly plugins: PluginsPort
  dispose(): Promise<void>
}
