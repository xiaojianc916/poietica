import { EngineErrorCode, type EngineSession, type EngineToolSpec, type OpenSessionSpec } from '@poietica/engine'
import { AppError, type Logger, SystemErrorCode } from '@poietica/foundation'
import type { DataLayout } from '@poietica/runtime-layout'
import type { SettingsScope } from '../settings-access'
import { createToolsExtension } from '../tools-extension'
import { allowGoalContinuation } from './goal-host'
import { applyPosture } from './posture'

export interface SessionFactoryOptions {
  readonly layout: DataLayout
  readonly logger: Logger
  readonly root: SettingsScope
  /** omp 的 createAgentSession（由测试入口或生产入口注入，便于离线跑 mock） */
  readonly createAgentSession: (options: Record<string, unknown>) => Promise<Record<string, unknown>>
  /** omp 的 SessionManager */
  readonly sessionManager: {
    create(
      cwd: string,
      sessionDir?: string,
    ): { getSessionId(): string; getSessionFile(): string | undefined; ensureOnDisk?(): Promise<void> }
    open(file: string, sessionDir?: string): Promise<{ getSessionId(): string; getSessionFile(): string | undefined }>
  }
  readonly authStorage: unknown
  readonly registry: unknown
  /** 引擎的工具表（会话建好后交给 adapter） */
  readonly tools: ReadonlyMap<string, EngineToolSpec>
  /** 测试缝：存在时跳过模型解析、直接用注入的 mock */
  readonly testSeams?: { readonly model?: unknown; readonly getApiKey?: (model: unknown) => string } | null
  readonly resolveModel: (selector: string | null) => { provider: string; id: string } | null
  readonly modelRoles: () => Readonly<Record<string, string>>
  /** 把 omp 的会话对象包成 OmpSession（由 omp-session-factory 的调用方提供，避免这里绑死形状） */
  readonly wrapSession: (input: {
    readonly spec: OpenSessionSpec
    readonly settings: SettingsScope
    readonly manager: unknown
    readonly agentSession: unknown
    readonly setToolUIContext: (ui: unknown, hasUI: boolean) => void
    readonly mcpManager: unknown
    readonly tools: ReadonlyMap<string, EngineToolSpec>
    /** createAgentSession 的完整返回值（adapter 要从它取 subagentEventBus） */
    readonly created: Record<string, unknown>
    /** 解析出的模型（null 表示交给 SDK 兜底） */
    readonly model: { provider: string; id: string } | null
  }) => Promise<EngineSession>
}

/**
 * SessionFactory。
 *
 * **串行化**（omp 知识 #9）：omp 进程内只有一个 “Main” 工具注册槽，两个 createAgentSession 并发执行会互相顶掉。
 * 做法是一条 Promise 链：每次 create 都接在上一次后面，无论上一次成功还是失败都继续。
 */
export class SessionFactory {
  private tail: Promise<unknown> = Promise.resolve()

  constructor(private readonly o: SessionFactoryOptions) {}

  create(spec: OpenSessionSpec): Promise<EngineSession> {
    const run = this.tail.then(
      () => this.open(spec),
      () => this.open(spec),
    )
    this.tail = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  private async open(spec: OpenSessionSpec): Promise<EngineSession> {
    // 每个会话一个 overlay：读取实时穿透到根实例，写入只进它自己的 override 层
    const settings =
      (this.o.root as { overlay?: (overrides?: Readonly<Record<string, unknown>>) => SettingsScope }).overlay?.() ??
      this.o.root
    applyPosture(settings, spec.posture)
    // 目标续跑：omp 的控制器只认 'rpc' 这一档，Poietica 按交互式宿主的设置放行（审查 R-11，goal-host.ts）
    allowGoalContinuation(settings)
    const manager = await this.openManager(spec)
    const model = this.resolveModelFor(spec)
    // omp 知识 #15：内置工具用 extensions 注册（customTools 会替换掉 omp 的默认工具）；
    // 工具表在会话建立时冻结成一份快照，之后的 registerTool 不影响已开的会话。
    const extensionFactory = (pi: { registerTool(tool: Record<string, unknown>): void }): void => {
      createToolsExtension({
        specs: this.o.tools,
        sessionKey: spec.key,
        cwd: spec.cwd,
        logger: this.o.logger,
        register: (tool) => pi.registerTool(tool),
      })
    }
    const created = await this.o.createAgentSession({
      extensions: [extensionFactory],
      cwd: spec.cwd,
      settings,
      sessionManager: manager,
      authStorage: this.o.authStorage,
      modelRegistry: this.o.registry,
      // omp 知识 #6：hasUI: true + setToolUIContext + initializeExtensions 三者缺一不可
      hasUI: true,
      ...(this.o.testSeams?.model === undefined ? {} : { model: this.o.testSeams.model }),
      ...(this.o.testSeams?.getApiKey === undefined ? {} : { getApiKey: this.o.testSeams.getApiKey }),
      ...(model === null ? {} : { model }),
      ...(spec.thinking === null ? {} : { thinkingLevel: spec.thinking }),
    })
    const agentSession = created.session
    const setToolUIContext = created.setToolUIContext
    if (typeof setToolUIContext !== 'function') {
      throw new AppError(SystemErrorCode.internal, 'no setToolUIContext in the result of createAgentSession')
    }
    const session = await this.o.wrapSession({
      spec,
      settings,
      manager,
      agentSession,
      setToolUIContext: setToolUIContext as (ui: unknown, hasUI: boolean) => void,
      mcpManager: created.mcpManager,
      tools: this.o.tools,
      created,
      model,
    })
    if (spec.sessionFile === null) await this.materialize(manager, session)
    return session
  }

  /**
   * 新会话建好就落盘（omp `SessionManager.ensureOnDisk`，ACP 的 session/new 同此处理）。
   *
   * omp 默认要等到**第一条助手回复**才写文件（omp 知识 #14），但 Core 在会话打开那一刻就把签发的路径绑到线程行上。
   * 两者之间的窗口里出任何事 —— 上游报错、用户取消、只改了设置、空闲驱逐 —— 行里就留下一个永远不会出现的文件：
   * 之后再打开报 session_file_missing，删除也删不掉（真实故障）。在这里落盘，换来一条不变量：**行上绑着的路径，文件一定在**。
   * 副作用只有一个空会话头（与 omp 自己 ACP 那一支一致），用户那句话即使没得到回复也留在了文件里。
   */
  private async materialize(manager: unknown, session: EngineSession): Promise<void> {
    const ensure = (manager as { ensureOnDisk?: () => Promise<void> }).ensureOnDisk
    if (typeof ensure !== 'function') return
    try {
      await ensure.call(manager)
    } catch (error) {
      /* 落不了盘就不交出这条会话：交出去就是一条「绑了路径、没有文件」的行 */
      await session.dispose().catch(() => undefined)
      throw error
    }
  }

  private async openManager(spec: OpenSessionSpec): Promise<unknown> {
    const sessionsDir = (this.o.layout as unknown as { ompSessionsDir?: string }).ompSessionsDir
    if (spec.sessionFile === null) {
      return this.o.sessionManager.create(spec.cwd, sessionsDir)
    }
    // omp 知识 #14：会话文件在首次水合之后才落盘，所以先确认它真的存在
    const exists = await this.exists(spec.sessionFile)
    if (!exists) {
      throw new AppError(EngineErrorCode.sessionFileMissing, `会话文件不存在：${spec.sessionFile}`)
    }
    return await this.o.sessionManager.open(spec.sessionFile, sessionsDir)
  }

  private exists(file: string): Promise<boolean> {
    // Bun 自带的存在性检查，省掉一次动态 import
    return Bun.file(file).exists()
  }

  /**
   * 解析模型（omp 知识 #7）：选择器是**整串** provider/id，不能按最后一个斜杠切分
   * （id 自己可能带斜杠，例如 workbuddy-ai/deepseek-v4.1-flash）。解析不出就不传，交给 SDK 兜底。
   */
  private resolveModelFor(spec: OpenSessionSpec): { provider: string; id: string } | null {
    // 测试缝：注入的 mock 模型直接交给 SDK，不做目录解析
    if (this.o.testSeams?.model !== undefined) return null
    const selector =
      spec.model === null ? (this.o.modelRoles().default ?? null) : `${spec.model.provider}/${spec.model.id}`
    if (selector === null) return null
    return this.o.resolveModel(selector)
  }
}
