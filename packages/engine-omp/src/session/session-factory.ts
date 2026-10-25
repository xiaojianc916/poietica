import { EngineErrorCode, type EngineSession, type EngineToolSpec, type OpenSessionSpec } from '@poietica/engine'
import { AppError, type Logger, SystemErrorCode } from '@poietica/foundation'
import type { DataLayout } from '@poietica/runtime-layout'
import type { SettingsScope } from '../settings-access'
import { createToolsExtension } from '../tools-extension'
import { allowGoalContinuation } from './goal-host'
import type { McpLease } from './mcp-workspaces'
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
    /** 不落盘的会话（预热用）；不给就不预热 */
    inMemory?(cwd: string): unknown
  }
  readonly authStorage: unknown
  readonly registry: unknown
  /** MCP 服务器的持有者（omp 知识 #22）：会话从这里借 manager；不给则退回 omp 的「每会话一份」 */
  readonly mcp?: { lease(cwd: string): Promise<McpLease> }
  /** 引擎的工具表（会话建好后交给 adapter） */
  readonly tools: ReadonlyMap<string, EngineToolSpec>
  /** 测试缝：存在时跳过模型解析、直接用注入的 mock */
  readonly testSeams?: { readonly model?: unknown; readonly getApiKey?: (model: unknown) => string } | null
  /** 测试缝：mock 也是 `tiny` 角色的候选，标题请求会吃掉一条脚本回复 */
  readonly disableAutoTitle?: boolean
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

/** 预热会话的工具上下文键：不对应任何线程，预热会话也从不跑一轮，工具不会被调用 */
const WARM_SESSION_KEY = '__warm__'

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
    return this.enqueue(() => this.open(spec))
  }

  /**
   * 预热：在同一条串行链上建一个**内存会话**再立刻丢掉，把进程里第一次 createAgentSession 的
   * 冷启动（实测 240–300ms，之后约 50ms：omp 一次性的模块求值、设置初始化与工具装配）付在用户
   * 发话之前 —— 新对话的第一句没有任何预热，这笔账原样落在首字延迟上。预热会话不碰任何有外部
   * 效果的东西（不写会话文件、不拉 MCP、不起 LSP、不开自动起名、不发现用户扩展）；失败只记 debug，
   * 真正的 open 照常走自己的路径。
   */
  warm(cwd: string): Promise<void> {
    return this.enqueue(() => this.prime(cwd))
  }

  /** omp 知识 #9：每次 createAgentSession 都接在上一次后面，无论上一次成功还是失败 */
  private enqueue<T>(job: () => Promise<T>): Promise<T> {
    const run = this.tail.then(job, job)
    this.tail = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  private async prime(cwd: string): Promise<void> {
    const inMemory = this.o.sessionManager.inMemory
    if (inMemory === undefined) return
    const model = this.resolveModelFor(null)
    const created = await this.o.createAgentSession({
      extensions: [this.toolsExtension(WARM_SESSION_KEY, cwd)],
      cwd,
      settings: this.overlay(),
      sessionManager: inMemory.call(this.o.sessionManager, cwd),
      authStorage: this.o.authStorage,
      modelRegistry: this.o.registry,
      hasUI: false,
      enableMCP: false,
      enableLsp: false,
      autoTitle: false,
      disableExtensionDiscovery: true,
      ...(this.o.testSeams?.model === undefined ? {} : { model: this.o.testSeams.model }),
      ...(this.o.testSeams?.getApiKey === undefined ? {} : { getApiKey: this.o.testSeams.getApiKey }),
      ...(model === null ? {} : { model }),
    })
    const dispose = (created.session as { dispose?: () => Promise<void> } | undefined)?.dispose
    if (typeof dispose === 'function') await dispose.call(created.session)
  }

  /** 每个会话一个 overlay：读取实时穿透到根实例，写入只进它自己的 override 层 */
  private overlay(): SettingsScope {
    return (
      (this.o.root as { overlay?: (overrides?: Readonly<Record<string, unknown>>) => SettingsScope }).overlay?.() ??
      this.o.root
    )
  }

  // omp 知识 #15：内置工具用 extensions 注册（customTools 会替换掉 omp 的默认工具）；
  // 工具表在会话建立时冻结成一份快照，之后的 registerTool 不影响已开的会话。
  private toolsExtension(sessionKey: string, cwd: string) {
    return (pi: { registerTool(tool: Record<string, unknown>): void }): void => {
      createToolsExtension({
        specs: this.o.tools,
        sessionKey,
        cwd,
        logger: this.o.logger,
        register: (tool) => pi.registerTool(tool),
      })
    }
  }

  private async open(spec: OpenSessionSpec): Promise<EngineSession> {
    const settings = this.overlay()
    applyPosture(settings, spec.posture)
    // 目标续跑：omp 的控制器只认 'rpc' 这一档，Poietica 按交互式宿主的设置放行（审查 R-11，goal-host.ts）
    allowGoalContinuation(settings)
    const manager = await this.openManager(spec)
    const model = this.resolveModelFor(spec.model)
    const lease = (await this.o.mcp?.lease(spec.cwd)) ?? null
    let session: EngineSession
    try {
      const created = await this.o.createAgentSession({
        extensions: [this.toolsExtension(spec.key, spec.cwd)],
        cwd: spec.cwd,
        settings,
        sessionManager: manager,
        authStorage: this.o.authStorage,
        modelRegistry: this.o.registry,
        // omp 知识 #6：hasUI: true + setToolUIContext + initializeExtensions 三者缺一不可
        hasUI: true,
        /*
         * omp 知识 #22：MCP 服务器归工作区（mcp-workspaces.ts），会话只借用。给了 mcpManager，omp 就不再
         * 为这个会话新建 manager、不在后台拉起服务器、dispose 时也不断开 —— 切对话不再杀掉重启全部 MCP 进程。
         * 工具不经 mcpTools 传：那一格会被 omp 算作「缓存形状变了」，续开分叉会话时丢掉继承的 prompt cache key；
         * 改由 attach 在会话建好后 refreshMCPTools（与 omp 延迟发现的路径相同）。
         */
        ...(lease === null ? {} : { mcpManager: lease.manager }),
        /*
         * omp 知识 #17：**必须在这里打开**。omp 的自动起名只由 `config.autoTitle === true` 这一道门放行
         * （agent-session.ts 的 `#noteTitleInput`），默认 false；宿主不传就一次都不会跑，线程永远停在首句兜底上。
         * `spec.autoTitle === false` 是线程自己的门禁（用户定过名的线程），测试缝关掉是为了别吃掉 mock 脚本。
         */
        autoTitle: this.o.disableAutoTitle !== true && spec.autoTitle !== false,
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
      await lease?.attach(agentSession as never)
      session = await this.o.wrapSession({
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
    } catch (error) {
      /* 幂等：attach 过的会话之后再 dispose 时还会调一次，那一次是空操作 */
      lease?.release()
      throw error
    }
    if (spec.sessionFile === null) await this.materialize(manager, session)
    return session
  }

  /**
   * 新会话建好就落盘（omp `SessionManager.ensureOnDisk`，ACP 的 session/new 同此处理）。
   * omp 默认要等第一条助手回复才写文件（omp 知识 #14），但 Core 在打开那一刻就把路径绑到线程行上
   * —— 中间出任何事，行里就留下一个永远不会出现的文件：打开报 session_file_missing、删除也删不掉
   * （真实故障）。在这里落盘，换来一条不变量：**行上绑着的路径，文件一定在**；副作用只有一个空会话头。
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
  private resolveModelFor(ref: OpenSessionSpec['model']): { provider: string; id: string } | null {
    // 测试缝：注入的 mock 模型直接交给 SDK，不做目录解析
    if (this.o.testSeams?.model !== undefined) return null
    const selector = ref === null ? (this.o.modelRoles().default ?? null) : `${ref.provider}/${ref.id}`
    if (selector === null) return null
    return this.o.resolveModel(selector)
  }
}
