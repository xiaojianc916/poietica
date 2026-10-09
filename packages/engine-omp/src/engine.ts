import {
  type AgentEngine,
  type Controls,
  type DraftControlInit,
  EngineErrorCode,
  type EngineInfo,
  type EngineSession,
  type EngineToolSpec,
  type ModelRef,
  type OpenSessionSpec,
  type Posture,
} from '@poietica/engine'
import { AppError, type Disposable, type Logger, SystemErrorCode, toDisposable } from '@poietica/foundation'

export interface OmpEngineOptions {
  readonly info: EngineInfo
  readonly logger: Logger
  /**
   * 草稿控件表的实现：由组合根（create-engine.ts）注入，因为它要读 omp 的注册表。
   *
   * 收的是「已经解好的那三格」而不是 DraftControlInit：默认模型要问 ModelsPort、
   * 默认档位要问设置，两者都属于组合根那一层，引擎本身不认识 omp。
   */
  readonly draftControls: (init: {
    readonly current: ModelRef | null
    readonly posture: Posture
    readonly thinking: string | null
  }) => Promise<Controls>
  readonly createSession: (spec: OpenSessionSpec, tools: ReadonlyMap<string, EngineToolSpec>) => Promise<EngineSession>
  readonly sessionFiles: AgentEngine['sessionFiles']
  readonly models: AgentEngine['models']
  readonly settings: AgentEngine['settings']
  readonly skills: AgentEngine['skills']
  readonly mcp: AgentEngine['mcp']
  readonly plugins: AgentEngine['plugins']
  /** 释放进程级资源（root Settings 的 flush、会话清理） */
  readonly disposeRuntime: () => Promise<void>
}

/**
 * OmpEngine（12 页 §6.2）。工具表在第一次 openSession 之前必须冻结：
 * 冻结前注册、冻结后只读，防止会话拿到不完整的工具表。
 */
export class OmpEngine implements AgentEngine {
  readonly info: EngineInfo
  private readonly tools = new Map<string, EngineToolSpec>()
  private readonly sessions = new Set<EngineSession>()
  private frozen = false
  private disposed = false

  constructor(private readonly o: OmpEngineOptions) {
    this.info = o.info
  }

  get sessionFiles() {
    return this.o.sessionFiles
  }
  get models() {
    return this.o.models
  }
  get settings() {
    return this.o.settings
  }
  get skills() {
    return this.o.skills
  }
  get mcp() {
    return this.o.mcp
  }
  get plugins() {
    return this.o.plugins
  }

  /** 已注册的工具（session-factory 建会话时取它） */
  toolSpecs(): ReadonlyMap<string, EngineToolSpec> {
    return this.tools
  }

  /**
   * 草稿控件表：**只读**，不开会话、不写设置、不碰文件（方案 §04）。
   *
   * 三格的来路与会话里那份完全一致：
   *   - `model.choices`：`registry.getAvailable()`（凭据作用域，与 omp 自己的选择器同源）；
   *   - `thinking.choices`：当前模型自己的档位梯子（`Model.thinking.efforts`，静态可得）；
   *   - `posture`：`init.posture ?? 'auto-edit'`（07 页 §5C 的 `threads.create` 同一条默认值）。
   *
   * `init` 只决定**哪一格被选中**：不改任何全局默认，也不落盘。
   */
  async draftControls(init?: DraftControlInit): Promise<Controls> {
    const current = init?.model ?? (await this.o.models.defaultModel())
    return this.o.draftControls({
      current,
      posture: init?.posture ?? 'auto-edit',
      thinking: init?.thinking ?? null,
    })
  }

  registerTool(spec: EngineToolSpec): Disposable {
    if (this.frozen) throw new AppError(EngineErrorCode.toolsFrozen, '工具注册已关闭')
    if (this.tools.has(spec.name)) {
      throw new AppError(SystemErrorCode.conflict, `工具重名：${spec.name}`)
    }
    this.tools.set(spec.name, spec)
    return toDisposable(() => {
      this.tools.delete(spec.name)
    })
  }

  freezeTools(): void {
    this.frozen = true
  }

  async openSession(spec: OpenSessionSpec): Promise<EngineSession> {
    if (!this.frozen) throw new AppError(EngineErrorCode.toolsFrozen, '工具注册尚未冻结')
    if (this.disposed) throw new AppError(SystemErrorCode.cancelled, '引擎已关闭')
    const session = await this.o.createSession(spec, this.tools)
    this.sessions.add(session)
    this.o.logger.info('session opened', { key: spec.key, sessionFile: session.sessionFile })
    return session
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    for (const session of this.sessions) {
      try {
        await session.dispose()
      } catch (error) {
        this.o.logger.warn('session dispose failed', {
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
    this.sessions.clear()
    await this.o.disposeRuntime()
  }
}
