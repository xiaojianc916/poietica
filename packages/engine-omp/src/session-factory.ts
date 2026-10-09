import { EngineErrorCode, type EngineSession, type EngineToolSpec, type OpenSessionSpec } from '@poietica/engine'
import { AppError, type Logger, SystemErrorCode } from '@poietica/foundation'
import { type DataLayout, dataLayout } from '@poietica/runtime-layout'
import { applyPosture } from './posture'
import { type SettingsScope, settingAt } from './settings-access'
import { createToolsExtension } from './tools-extension'

export interface SessionFactoryOptions {
  readonly layout: DataLayout
  readonly logger: Logger
  readonly root: SettingsScope
  /** omp 的 createAgentSession（由测试入口或生产入口注入，便于离线跑 mock） */
  readonly createAgentSession: (options: Record<string, unknown>) => Promise<Record<string, unknown>>
  /** omp 的 SessionManager */
  readonly sessionManager: {
    create(cwd: string, sessionDir?: string): { getSessionId(): string; getSessionFile(): string | undefined }
    open(file: string, sessionDir?: string): Promise<{ getSessionId(): string; getSessionFile(): string | undefined }>
  }
  readonly authStorage: unknown
  readonly registry: unknown
  /** 引擎的工具表（会话建好后交给 adapter） */
  readonly tools: ReadonlyMap<string, EngineToolSpec>
  /** 测试缝（12 页 §12.1）：存在时跳过模型解析、直接用注入的 mock */
  readonly testSeams?: { readonly model?: unknown; readonly getApiKey?: (model: unknown) => string } | null
  /** 本会话的模型解析（12 页 §6.3 第 3 步） */
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
 * SessionFactory（12 页 §6.3）。
 *
 * **串行化**（omp 知识 #9）：omp 进程内只有一个 “Main” 工具注册槽，两个 createAgentSession 并发执行会互相顶掉。
 * 做法是一条 Promise 链：每次 create 都接在上一次后面，无论上一次成功还是失败都继续。
 *
 * 与 legacy 的差异：legacy 先用 SessionManager.create 发号、后台再水合；新设计里引擎只提供「打开会话」这个原子操作，
 * 界面先出现由 conversation 的会话池负责。
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
    // 每个会话一个 overlay：读取实时穿透到根实例，写入只进它自己的 override 层（12 页 §5.1）
    const settings =
      (this.o.root as { overlay?: (overrides?: Readonly<Record<string, unknown>>) => SettingsScope }).overlay?.() ??
      this.o.root
    applyPosture(settings, spec.posture)
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
    return await this.o.wrapSession({
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
    return import('node:fs').then((fs) => fs.existsSync(file))
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

/** 设置相关的一处小工具：确认某个设置项存在（认不出的路径如实报错） */
export function assertSettingExists(path: string): void {
  settingAt(path)
}

/** 由 Core 参数的数据根算出布局（Core 的 serve.ts 与探针共用） */
export function layoutOf(dataRoot: string): DataLayout {
  return dataLayout(dataRoot)
}
