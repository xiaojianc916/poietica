import type { AgentEngine } from '@poietica/engine'
import { AppError, type Logger, SystemErrorCode } from '@poietica/foundation'
import type { DataLayout } from '@poietica/runtime-layout'
import { OmpEngine } from './engine'
import { disableForeignProviders, releaseForeignProviders } from './foreign-providers'
import { resolveSessionModel } from './model-resolve'
import type { OmpSessionLike } from './omp-context'
import { draftControlsOf } from './ports/draft-controls'
import { registryPortOf } from './ports/model-helpers'
import { migrateLegacyTitleRole } from './ports/models'
import { ompPorts } from './ports/omp-ports'
import { wrapOmpSession } from './session/omp-session-adapter'
import { SessionFactory } from './session/session-factory'
import { isConfiguredSetting, overrideSetting, readSetting, writeGlobalSetting } from './settings-access'

export interface CreateEngineOptions {
  readonly layout: DataLayout
  readonly logger: Logger
  readonly relayPort: number
  readonly appVersion: string
  /** omp 的版本（来自 package.json） */
  readonly engineVersion: string
}

/** 测试缝：只有 ./testing 能拿到，不从包根导出。model 存在时跳过模型解析、直接用 mock */
export interface EngineTestSeams {
  readonly model?: unknown
  readonly getApiKey?: (model: unknown) => string
  /**
   * 关掉自动总结标题（omp 知识 #17）：mock provider 同时也是 `tiny` 角色的候选，标题请求会**吃掉一条
   * 脚本回复** —— 那测的是脚本被谁消费，不是引擎语义。生产入口不传（seams 恒为 null）。
   */
  readonly disableAutoTitle?: boolean
}

/** omp 的模块入口：集中在这里动态 import，便于测试替换与阅读创建顺序 */
async function ompModules() {
  const [sdk, settings, registry, sessions, capability] = await Promise.all([
    import('@oh-my-pi/pi-coding-agent'),
    import('@oh-my-pi/pi-coding-agent/config/settings'),
    import('@oh-my-pi/pi-coding-agent/config/model-registry'),
    import('@oh-my-pi/pi-coding-agent/session/session-manager'),
    import('@oh-my-pi/pi-coding-agent/capability'),
  ])
  return {
    Settings: settings.Settings,
    ModelRegistry: registry.ModelRegistry,
    // discoverAuthStorage 在包根（sdk.d.ts:415），不在 auth-storage 子模块
    discoverAuthStorage: sdk.discoverAuthStorage,
    SessionManager: sessions.SessionManager,
    createAgentSession: sdk.createAgentSession,
    // omp 知识 #10：disableProvider 写的是「当前绑定的那个 Settings」，所以必须先 initializeWithSettings
    initializeWithSettings: capability.initializeWithSettings,
    disableProvider: capability.disableProvider,
    enableProvider: capability.enableProvider,
  }
}

/**
 * omp 知识 #16：Core 的编译参数必须与 omp 官方一致（关闭四类自动加载、bytecode、external
 * fastembed/onnxruntime-node、define PI_COMPILED），那一步在 apps/core/scripts/build.ts。
 *
 * 创建顺序就是正确性：ensureThemeSync（omp 知识 #3：ask 工具无条件读主题单例）→ Settings.init 后
 * initializeWithSettings（omp 知识 #10 的前置）→ 先放行已撤销的外来 provider 再禁用剩下的（omp 知识
 * #10）→ browser.relay 只在从未配置过时写默认值（omp 知识 #11）→ browser.relayUrl 只写运行时覆盖层
 * → 模型注册表先补本地目录、联网发现放后台（**不要** await refresh：缓存过期时它会当场等网络）
 * → 工具表、SessionFactory、6 个端口。
 */
/** 生产入口：包根的 createOmpEngine(opts) 就是它（seams 恒为 null） */
export async function createOmpEngineWith(o: CreateEngineOptions, seams: EngineTestSeams | null): Promise<AgentEngine> {
  // omp 知识 #3
  const theme = await import('@oh-my-pi/pi-tui/theme')
  theme.ensureThemeSync()
  const omp = await ompModules()
  const root = await omp.Settings.init()
  // omp 知识 #10：先绑定再禁用。capability 的开关只在绑定过 Settings 之后才读写它；没有这一步，
  // disableProvider 落进一个「未绑定」的进程级集合，配置一刷就被丢掉，外来 provider 会照常被读进隔离根。
  omp.initializeWithSettings(root)
  // 先撤再禁：旧版本把 `agents` 写进过 disabledProviders，顺序反过来会当场又禁回去。
  const released = await releaseForeignProviders(root, () => root.flush(), omp.enableProvider)
  if (released.length > 0) o.logger.info('foreign providers released', { count: released.length })
  const disabled = await disableForeignProviders(root, () => root.flush(), omp.disableProvider)
  if (disabled.length > 0) o.logger.info('foreign providers disabled', { count: disabled.length })
  // omp 知识 #11：只有这一格从来没被谁配过才落一次默认值
  if (!isConfiguredSetting(root, 'browser.relay')) {
    writeGlobalSetting(root, 'browser.relay', true)
    await root.flush()
  }
  overrideSetting(root, 'browser.relayUrl', `http://127.0.0.1:${String(o.relayPort)}`)
  // 自动总结标题（omp 知识 #17）：不额外改任何设置，omp 的默认就是产品要的；旧版自造的 modelRoles.title 迁进 omp 的 tiny 角色
  if (await migrateLegacyTitleRole(root)) o.logger.info('legacy title model role migrated to tiny')
  const authStorage = await omp.discoverAuthStorage()
  const registry = new omp.ModelRegistry(authStorage)
  await registry.hydrateCredentialScopedModelCaches()
  registry.refreshInBackground()

  /* 端口与引擎共用同一份活会话表（MCP 的状态要按名汇总各活会话的 mcpManager）；端口另建一个空 Set 的话，mcp.status() 永远报不出任何一台服务器 */
  const liveSessions = new Set<OmpSessionLike>()
  const ports = await ompPorts({
    layout: o.layout,
    logger: o.logger,
    root,
    registry,
    authStorage,
    relayPort: o.relayPort,
    sessions: liveSessions,
  })
  // 先把引擎建出来（它持有工具表的唯一真相）再交给 SessionFactory：两份 Map 会让 registerTool 写进 A、会话从 B 读
  let factory: SessionFactory | null = null
  const engine = new OmpEngine({
    info: { name: 'omp', version: o.engineVersion },
    logger: o.logger,
    createSession: (spec) => {
      if (factory === null) throw new AppError(SystemErrorCode.internal, 'SessionFactory 尚未就绪')
      return factory.create(spec)
    },
    sessionFiles: ports.sessionFiles,
    /* 只有组合根这层同时拿得到 RegistryPort 与 root Settings，所以草稿控件表的实现挂在这里，由 OmpEngine.draftControls 转发 */
    draftControls: (init) =>
      Promise.resolve(
        draftControlsOf({
          current: init.current,
          posture: init.posture,
          registry: registryPortOf(registry),
          root,
          thinking: init.thinking,
          hidden: init.hidden,
        }),
      ),
    models: ports.models,
    settings: ports.settings,
    skills: ports.skills,
    mcp: ports.mcp,
    plugins: ports.plugins,
    disposeRuntime: async () => {
      await root.flush()
    },
  })
  const tools = engine.toolSpecs()
  factory = new SessionFactory({
    layout: o.layout,
    logger: o.logger,
    root,
    createAgentSession: async (options) =>
      (await omp.createAgentSession(options as never)) as unknown as Record<string, unknown>,
    sessionManager: omp.SessionManager,
    authStorage,
    registry,
    tools,
    testSeams: seams,
    /* 解析出**注册表里那一条实例**（不是精简对 —— SDK 要读 identity / api / baseUrl）；还要求 provider 真的配过凭据 */
    resolveModel: (selector) =>
      resolveSessionModel(
        {
          find: (provider, id) => registry.find(provider, id),
          hasConfiguredAuth: (model) => registry.hasConfiguredAuth(model as never),
        },
        selector,
      ),
    modelRoles: () => {
      const roles = readSetting(root, 'modelRoles')
      return typeof roles === 'object' && roles !== null ? (roles as Record<string, string>) : {}
    },
    wrapSession: async (sessionInput) => {
      const wrapped = await wrapOmpSession({
        ...sessionInput,
        logger: o.logger,
        subagentBus:
          (
            sessionInput.created as {
              subagentEventBus?: { on(channel: string, listener: (data: unknown) => void): () => void }
            }
          ).subagentEventBus ?? null,
        // omp 知识 #6：initializeExtensions 只在 '/modes/runtime-init' 子路径导出
        initializeExtensions: async (agentSession: unknown, uiContext: unknown) => {
          const init = await import('@oh-my-pi/pi-coding-agent/modes/runtime-init')
          await init.initializeExtensions(agentSession as never, {
            mode: 'print',
            uiContext: uiContext as never,
            reportSendError: (action, error) =>
              o.logger.warn('extension send failed', { action, error: error.message }),
            reportRuntimeError: (error) => o.logger.warn('extension runtime error', { error: String(error) }),
          })
        },
        model: sessionInput.model,
        thinking: sessionInput.spec.thinking,
        disableAutoTitle: seams?.disableAutoTitle === true,
        /* 静态目录：模型名字与思考梯子烤在 omp 的注册表里，开会话之前就查得到。消费者是 `controls()` 的思考候选 / 默认档兜底与模型候选的 label */
        modelCatalog: (ref) => {
          const found = registry.find(ref.provider, ref.id)
          if (found === undefined) return null
          return {
            label: found.name ?? found.id,
            efforts: found.thinking?.efforts ?? [],
            defaultLevel: found.thinking?.defaultLevel ?? null,
          }
        },
      })
      /* 活会话账：MCP 的状态要按名汇总各活会话的 mcpManager。会话关掉就摘掉 —— 留着死会话的坑，界面上的状态灯会一直在 */
      const live: OmpSessionLike = {
        sessionId: wrapped.sessionId,
        sessionKey: sessionInput.spec.key,
        mcpManager: sessionInput.mcpManager as OmpSessionLike['mcpManager'],
      }
      liveSessions.add(live)
      ports.mcpRefreshStatus()
      const originalDispose = wrapped.dispose.bind(wrapped)
      return Object.assign(wrapped, {
        async dispose(): Promise<void> {
          liveSessions.delete(live)
          await originalDispose()
          ports.mcpRefreshStatus()
        },
      })
    },
  })
  return engine
}
