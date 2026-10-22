import type { AgentEngine } from '@poietica/engine'
import { AppError, type Logger, SystemErrorCode } from '@poietica/foundation'
import type { DataLayout } from '@poietica/runtime-layout'
import { OmpEngine } from './engine'
import { disableForeignProviders, releaseForeignProviders } from './foreign-providers'
import { resolveSessionModel } from './model-resolve'
import { draftControlsOf } from './ports/draft-controls'
import { registryPortOf } from './ports/model-helpers'
import { migrateLegacyTitleRole } from './ports/models'
import { ompPorts } from './ports/omp-ports'
import { McpWorkspaces } from './session/mcp-workspaces'
import { blobMediaRef } from './session/media-store'
import { wrapOmpSession } from './session/omp-session-adapter'
import { SessionFactory } from './session/session-factory'
import { listCommandCatalog } from './session/slash-commands'
import { isConfiguredSetting, overrideSetting, readSetting, writeGlobalSetting } from './settings-access'

export interface CreateEngineOptions {
  readonly layout: DataLayout
  readonly logger: Logger
  /** 本进程 browser relay 的端口（只写运行时覆盖层，不落盘）；0 = 这一次不开（测试、探针），browserRelay() 报 null */
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
  /** MCP 工作区的空闲宽限期（默认 MCP_IDLE_GRACE_MS）：测试用它验证「宽限到期进程退出」而不必等几分钟 */
  readonly mcpIdleGraceMs?: number
}

/** omp 的模块入口：集中在这里动态 import，便于测试替换与阅读创建顺序 */
async function ompModules() {
  const [sdk, settings, registry, sessions, capability, mcpManager, mcpToolCache, mcpConfig, executor, agentSession] =
    await Promise.all([
      import('@oh-my-pi/pi-coding-agent'),
      import('@oh-my-pi/pi-coding-agent/config/settings'),
      import('@oh-my-pi/pi-coding-agent/config/model-registry'),
      import('@oh-my-pi/pi-coding-agent/session/session-manager'),
      import('@oh-my-pi/pi-coding-agent/capability'),
      import('@oh-my-pi/pi-coding-agent/mcp/manager'),
      import('@oh-my-pi/pi-coding-agent/mcp/tool-cache'),
      import('@oh-my-pi/pi-coding-agent/mcp/config'),
      import('@oh-my-pi/pi-coding-agent/task/executor'),
      import('@oh-my-pi/pi-coding-agent/session/agent-session'),
    ])
  return {
    // omp 知识 #22：MCP 归工作区，引擎持有 manager、会话借用（session/mcp-workspaces.ts）
    mcp: {
      MCPManager: mcpManager.MCPManager,
      MCPToolCache: mcpToolCache.MCPToolCache,
      loadAllMCPConfigs: mcpConfig.loadAllMCPConfigs,
      shouldFilterBrowserMCPForPrelude: mcpConfig.shouldFilterBrowserMCPForPrelude,
      createMCPProxyTools: executor.createMCPProxyTools,
      followMCPTools: executor.followMCPTools,
      turnWaitMs: agentSession.MCP_DISCOVERY_TURN_WAIT_MS,
    },
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
 * 产品默认：只在这一格从来没被谁配过时落一次，人改过的值永远不被覆盖。
 * - browser.relay：浏览器中继默认开；
 * - retry.maxRetries：自动重试最多 5 次。omp 默认 10 次，服务商真出问题时要等很久才报错，界面上就是「正在重试 n/10」一直往上走。
 */
const PRODUCT_DEFAULTS: readonly (readonly [string, unknown])[] = [
  ['browser.relay', true],
  ['retry.maxRetries', 5],
]

/**
 * omp 知识 #16：Core 的编译参数必须与 omp 官方一致（关闭四类自动加载、bytecode、external
 * fastembed/onnxruntime-node、define PI_COMPILED），那一步在 apps/core/scripts/build.ts。
 *
 * 创建顺序就是正确性：ensureThemeSync（omp 知识 #3：ask 工具无条件读主题单例）→ Settings.init 后
 * initializeWithSettings（omp 知识 #10 的前置）→ 先放行已撤销的外来 provider 再禁用剩下的（omp 知识
 * #10）→ 产品默认（PRODUCT_DEFAULTS）只在从未配置过时写一次（omp 知识 #11）→ browser.relayUrl 只写运行时覆盖层
 * → 模型注册表先补本地目录、联网发现放后台（**不要** await refresh：缓存过期时它会当场等网络）
 * → MCP 工作区（omp 知识 #22）→ 工具表、SessionFactory、6 个端口。
 */
/** 生产入口：包根的 createOmpEngine(opts) 就是它（seams 恒为 null） */
export async function createOmpEngineWith(o: CreateEngineOptions, seams: EngineTestSeams | null): Promise<AgentEngine> {
  // omp 知识 #3
  const theme = await import('@oh-my-pi/pi-tui/theme')
  theme.ensureThemeSync()
  const omp = await ompModules()
  const root = await omp.Settings.init()
  /* 全部会话共用一个：按图片块对象记住算过的地址，翻页不重算 */
  const mediaRef = blobMediaRef(o.layout.ompBlobsDir)
  // omp 知识 #10：先绑定再禁用。capability 的开关只在绑定过 Settings 之后才读写它；没有这一步，
  // disableProvider 落进一个「未绑定」的进程级集合，配置一刷就被丢掉，外来 provider 会照常被读进隔离根。
  omp.initializeWithSettings(root)
  // 先撤再禁：旧版本把 `agents` 写进过 disabledProviders，顺序反过来会当场又禁回去。
  const released = await releaseForeignProviders(root, () => root.flush(), omp.enableProvider)
  if (released.length > 0) o.logger.info('foreign providers released', { count: released.length })
  const disabled = await disableForeignProviders(root, () => root.flush(), omp.disableProvider)
  if (disabled.length > 0) o.logger.info('foreign providers disabled', { count: disabled.length })
  // omp 知识 #11：只有这一格从来没被谁配过才落一次默认值
  const unset = PRODUCT_DEFAULTS.filter(([path]) => !isConfiguredSetting(root, path))
  for (const [path, value] of unset) writeGlobalSetting(root, path, value)
  if (unset.length > 0) await root.flush()
  overrideSetting(root, 'browser.relayUrl', `http://127.0.0.1:${String(o.relayPort)}`)

  //标题只留正文，不要 omp 的卡片前缀（`🎤 POET: …` 那个图标 + 代号）
  overrideSetting(root, 'title.icons', 'boring')
  // 自动总结标题（omp 知识 #17）：旧版自造的 modelRoles.title 迁进 omp 的 tiny 角色

  if (await migrateLegacyTitleRole(root)) o.logger.info('legacy title model role migrated to tiny')
  const authStorage = await omp.discoverAuthStorage()
  const registry = new omp.ModelRegistry(authStorage)
  await registry.hydrateCredentialScopedModelCaches()
  registry.refreshInBackground()

  /* MCP 服务器归工作区（omp 知识 #22）：端口的状态从这里的共享 manager 汇总，配置写入后让旧连接退役 */
  let refreshMcpStatus = (): void => undefined
  const mcp = new McpWorkspaces({
    runtime: omp.mcp,
    root,
    authStorage,
    logger: o.logger,
    onStatus: () => refreshMcpStatus(),
    ...(seams?.mcpIdleGraceMs === undefined ? {} : { idleGraceMs: seams.mcpIdleGraceMs }),
  })
  const ports = await ompPorts({
    layout: o.layout,
    logger: o.logger,
    root,
    registry,
    authStorage,
    mcpManagers: () => mcp.managers(),
    onMcpConfigChanged: () => mcp.retireAll(),
    mediaRef,
  })
  refreshMcpStatus = ports.mcpRefreshStatus
  // 先把引擎建出来（它持有工具表的唯一真相）再交给 SessionFactory：两份 Map 会让 registerTool 写进 A、会话从 B 读
  let factory: SessionFactory | null = null
  const engine = new OmpEngine({
    info: { name: 'omp', version: o.engineVersion },
    logger: o.logger,
    browserRelay: o.relayPort > 0 ? { port: o.relayPort } : null,
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
    commandCatalog: (cwd, options) => listCommandCatalog(cwd, options),
    models: ports.models,
    settings: ports.settings,
    skills: ports.skills,
    mcp: ports.mcp,
    plugins: ports.plugins,
    disposeRuntime: async () => {
      /* 会话都已关掉（OmpEngine.dispose 先关会话）：宽限期里的服务器在这里一并退出 */
      await mcp.dispose()
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
    mcp,
    testSeams: seams,
    disableAutoTitle: seams?.disableAutoTitle === true,
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
    wrapSession: (sessionInput) =>
      wrapOmpSession({
        ...sessionInput,
        logger: o.logger,
        mediaRef,
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
      }),
  })
  return engine
}
