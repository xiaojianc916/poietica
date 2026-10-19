import {
  type AgentEngine,
  type BrowserRelayEndpoint,
  type Controls,
  type DraftControlInit,
  EngineErrorCode,
  type EngineInfo,
  type EngineSession,
  type EngineToolSpec,
  type ModelRef,
  type OpenSessionSpec,
  type Posture,
  type SlashCommand,
} from '@poietica/engine'
import { AppError, type Disposable, type Logger, SystemErrorCode, toDisposable } from '@poietica/foundation'

export interface OmpEngineOptions {
  readonly info: EngineInfo
  readonly logger: Logger
  /** 本进程 omp 的 browser relay 在哪儿（端口由组合根挑好并写进 omp 的 browser.relayUrl）；没开为 null */
  readonly browserRelay: BrowserRelayEndpoint | null
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
    readonly hidden: readonly string[]
  }) => Promise<Controls>
  /** 不开会话的命令表（入口页的命令面板）；实现要读 omp 的命令注册表，所以同样由组合根注入 */
  readonly commandCatalog: AgentEngine['commandCatalog']
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
 * OmpEngine。工具表在第一次 openSession 之前必须冻结：
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

  browserRelay(): BrowserRelayEndpoint | null {
    return this.o.browserRelay
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
   * 草稿控件表：**只读**，不开会话、不写设置、不碰文件。
   *
   * 三格的来路与会话里那份完全一致：
   *   - `model.choices`：`registry.getAvailable()`（凭据作用域，与 omp 自己的选择器同源）；
   *   - `thinking.choices`：当前模型自己的档位梯子（`Model.thinking.efforts`，静态可得）；
   *   - `posture`：`init.posture ?? 'auto-edit'`（`threads.create` 同一条默认值）。
   *
   * `init` 只决定**哪一格被选中**：不改任何全局默认，也不落盘。
   */
  async draftControls(init?: DraftControlInit): Promise<Controls> {
    /*
     * 没给模型时整份取默认意图（`modelRoles.default` 连同它的 `:档位`），与 omp 建会话的顺序一致：
     * 选择器里显式的档位只在「没有显式模型」时生效（sdk 的 pickInitialThinkingLevel）。给了模型就不套
     * 默认后缀 —— 那一档是为默认模型写的，套到别的模型上是第二份语义。
     */
    const explicit = init?.model ?? null
    const fallback = explicit === null ? await this.o.models.defaultSelection() : null
    return this.o.draftControls({
      current: explicit ?? fallback?.model ?? null,
      posture: init?.posture ?? 'auto-edit',
      thinking: init?.thinking ?? fallback?.thinking ?? null,
      hidden: init?.hidden ?? [],
    })
  }

  async commandCatalog(cwd: string | null): Promise<readonly SlashCommand[]> {
    return await this.o.commandCatalog(cwd)
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
    if (this.disposed) {
      // dispose() 已经跑过：这个会话出生即晚点，当场关掉，绝不能留在外面
      await session.dispose().catch(() => undefined)
      throw new AppError(SystemErrorCode.cancelled, '引擎已关闭')
    }
    this.track(session)
    this.o.logger.info('session opened', { key: spec.key, sessionFile: session.sessionFile })
    return session
  }

  /** 仅测试使用：当前登记在册（已打开且未 dispose）的会话数 */
  liveSessionCount(): number {
    return this.sessions.size
  }

  /**
   * 登记会话，并包一层 dispose：无论谁关闭它（会话池、线程删除、引擎自己），
   * 都从登记表里移除；同一会话重复 dispose 只走一次原实现（R-05）。
   */
  private track(session: EngineSession): void {
    this.sessions.add(session)
    const original = session.dispose.bind(session)
    let disposing: Promise<void> | undefined
    Object.assign(session, {
      dispose: (): Promise<void> => {
        disposing ??= original().finally(() => {
          this.sessions.delete(session)
        })
        return disposing
      },
    })
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    await Promise.all(
      [...this.sessions].map((session) =>
        session.dispose().catch((error: unknown) => {
          this.o.logger.warn('session dispose failed', {
            error: error instanceof Error ? error.message : String(error),
          })
        }),
      ),
    )
    this.sessions.clear()
    await this.o.disposeRuntime()
  }
}
