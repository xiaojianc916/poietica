import type { Disposable } from '@poietica/foundation'
import type { BrowserRelayEndpoint } from './browser-relay'
import type { McpPort, ModelsPort, PluginsPort, SessionFilesPort, SettingsPort, SkillsPort } from './ports'
import type { EngineSession, OpenSessionSpec } from './session'
import type { EngineToolSpec } from './tools'
import type { Controls, ModelRef, Posture, SlashCommand } from './values'

export interface EngineInfo {
  readonly name: 'omp'
  readonly version: string
}

/**
 * 草稿选择：入口页（还没有 threadId）画选择器要用的那几格。全部可选，缺席的由引擎填默认值
 * （模型与档位用 modelRoles.default 这一份意图——选择器可带 `:档位`；没写档位再按模型默认档、
 * 全局 defaultThinkingLevel 兜；姿态用 auto-edit）。显式给了 model 时不套默认选择器里的档位。
 */
export interface DraftControlInit {
  readonly model?: ModelRef | null
  readonly thinking?: string | null
  readonly posture?: Posture
  /**
   * 用户在「已配置的模型」里关掉的那些（provider/id）。**只**约束兜底：没给 model、也没有全局默认时，
   * 不从这里面挑第一条；显式给出的 ref 照原样报出（那是用户自己的选择）。
   */
  readonly hidden?: readonly string[]
}

export interface CommandCatalogOptions {
  /** 这条对话已经有过对话（会话文件在）：压缩、重试、重命名这类只对已有对话有意义的命令也列出来。缺省 false（入口页）。 */
  readonly history?: boolean
}

export interface AgentEngine {
  readonly info: EngineInfo
  /**
   * **只读**出一份草稿控件表：不开会话、不写设置、不碰任何文件。规则与会话里那份一致：可选模型来自
   * registry.getAvailable()，思考档位按当前模型给出（omp 的 Model.thinking.efforts，静态可得），默认姿态是 auto-edit。
   */
  draftControls(init?: DraftControlInit): Promise<Controls>
  /**
   * 不开会话的斜杠命令表：内置命令加 `cwd` 下的文件命令。两处用它 —— 入口页（还没有对话），以及**没开着**的对话
   * （看一眼历史对话不为一张命令表去打开会话，性能方案 P4）。扩展、自定义 TS 命令与 MCP 提示词要会话装起来才有，不在表里；
   * 会话打开后调用方改问 `EngineSession.commands()`。`cwd` 为 null 时只列内置命令。
   * 只对已有对话起作用的那几条（压缩、重试、重命名……）只在 `options.history` 为 true 时列出。
   */
  commandCatalog(cwd: string | null, options?: CommandCatalogOptions): Promise<readonly SlashCommand[]>
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
  /**
   * 内置浏览器要连的 relay 服务（见 ./browser-relay.ts）。引擎没有这项能力、或这一次没开（测试替身、探针）时为 null。
   * 端口由引擎自己挑：Host 不再在启动参数里替它选，内核与启动契约因此不认识 relay。
   */
  browserRelay(): BrowserRelayEndpoint | null
  dispose(): Promise<void>
}
