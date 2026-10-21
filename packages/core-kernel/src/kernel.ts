import type { AppContract } from '@poietica/contract-kit'
import type { AgentEngine } from '@poietica/engine'
import {
  AppError,
  type Clock,
  createServiceRegistry,
  Deferred,
  DisposableStore,
  type Logger,
  SystemErrorCode,
  sortModules,
  withTimeout,
} from '@poietica/foundation'
import { type InboundContext, Router, RpcPeer, type Transport } from '@poietica/rpc'
import { CORE_SHUTDOWN_BUDGET_MS, type DataLayout } from '@poietica/runtime-layout'
import { type Database, openDatabase, runMigrations } from '@poietica/storage-sqlite'
import { createAgentToolRegistry } from './agent-tools'
import { createEventHub } from './events'
import type { CoreModule, CoreModuleContext } from './module'
import { createCoreRpcBinding, createHostCaller } from './rpc-binding'

export interface CoreKernelOptions {
  readonly modules: readonly CoreModule[]
  readonly engine: AgentEngine
  /** 测试传 ':memory:' */
  readonly databaseFile: string
  readonly layout: DataLayout
  readonly logger: Logger
  readonly clock: Clock
  readonly transport: Transport
  readonly appContract: AppContract
  readonly protocolVersion: number
  readonly coreVersion: string
  readonly engineVersion: string
  readonly strict: boolean
  readonly runtime: {
    readonly scrubbedEnvKeys: readonly string[]
    setLogLevel(level: 'debug' | 'info' | 'warn' | 'error'): void
  }
}

export interface CoreKernel {
  start(): Promise<void>
  shutdown(reason: string): Promise<void>
  /** shutdown 完成后回调（apps/core 用它 process.exit） */
  onExit(fn: (code: number) => void): void
  /** 仅测试使用：读取某模块提供的服务 */
  readonly services: { get: CoreModuleContext['services']['get'] }
}

type KernelState = 'created' | 'starting' | 'ready' | 'stopping' | 'stopped'

const SHUTDOWN_HOOK_TIMEOUT_MS = 5_000
/**
 * 启动途中被要求关停时，等「正在跑的那一步」（某个 setup / onReady）收手的上限。
 * 不等就会在钩子还在用库的时候 close 掉数据库；等太久会吃掉后面钩子的预算。
 */
const STARTUP_ABORT_WAIT_MS = 3_000
const INFLIGHT_DRAIN_MS = 1_500
/** engine.dispose 的时间下限：即使前面把预算花光了也要给它。 */
const ENGINE_DISPOSE_FLOOR_MS = 1_000

export function createCoreKernel(opts: CoreKernelOptions): CoreKernel {
  const log = opts.logger.child({ scope: 'kernel' })
  const router = new Router()
  const registry = createServiceRegistry()
  const eventHub = createEventHub()
  const readyHooks: Array<{ moduleId: string; fn: () => void | Promise<void> }> = []
  const shutdownHooks: Array<{ moduleId: string; fn: () => void | Promise<void> }> = []
  const moduleDisposables: DisposableStore[] = []
  const exitListeners: Array<(code: number) => void> = []
  let state: KernelState = 'created'
  let exitCode: number | null = null
  /** start() 的进行中 Promise：shutdown 在启动途中到来时要先等它在下一个检查点收手 */
  let starting: Promise<void> | undefined
  let peer: RpcPeer | undefined
  let db: Database | undefined
  let toolsFrozen = false
  let inflight = 0
  let drained: Deferred<void> | undefined

  const getPeer = (): RpcPeer => {
    if (peer === undefined) throw new AppError(SystemErrorCode.internal, 'RPC 对端尚未创建')
    return peer
  }

  async function onRequest(method: string, params: unknown, ctx: InboundContext): Promise<unknown> {
    if (method === 'core.shutdown') {
      queueMicrotask(() => {
        void shutdown('requested by host')
      })
      return {}
    }
    if (state !== 'ready') throw new AppError(SystemErrorCode.coreUnavailable, `Core 当前状态为 ${state}，暂不处理请求`)
    inflight++
    try {
      return await router.handle(method, params, ctx)
    } finally {
      inflight--
      if (inflight === 0) drained?.resolve()
    }
  }

  function validateModules(sorted: readonly CoreModule[]): void {
    const contractIds = new Set(opts.appContract.contracts.map((c) => c.id))
    for (const m of sorted) {
      if (m.contract === undefined) continue
      if (m.contract.id !== m.id) {
        throw new AppError(
          SystemErrorCode.moduleGraphInvalid,
          `模块 ${m.id} 的契约 id 是 ${m.contract.id}，二者必须相同`,
        )
      }
      if (!contractIds.has(m.contract.id)) {
        throw new AppError(SystemErrorCode.moduleGraphInvalid, `模块 ${m.id} 的契约没有被 @poietica/protocol 汇总`)
      }
    }
  }

  function assertAllCoreMethodsHandled(): void {
    const missing: string[] = []
    for (const [name, def] of opts.appContract.methods) {
      if (def.owner !== 'core' || name === 'core.shutdown') continue
      if (!router.has(name)) missing.push(name)
    }
    if (missing.length > 0) {
      throw new AppError(SystemErrorCode.unhandledMethod, `以下 owner='core' 的方法没有实现：${missing.join(', ')}`)
    }
  }

  /**
   * 启动途中是否已被叫停（core.shutdown / Host 断开）。守则 §8.3：每个 await 之后都要重查 ——
   * 否则关停跑完、库已关、exit 回调已发之后，start 还会接着跑剩下的 setup / onReady，最后把
   * 状态写回 ready 并对着已释放的对端发 core.ready。
   */
  const aborted = (): boolean => state !== 'starting'

  function start(): Promise<void> {
    if (state !== 'created') return Promise.reject(new AppError(SystemErrorCode.conflict, 'start() 只能调用一次'))
    state = 'starting'
    starting = startModules()
    return starting
  }

  /** 顺序执行 onReady；单个失败只记录并发 core.notice。每一步前后都重查是否已被叫停。 */
  async function runReadyHooks(): Promise<void> {
    for (const h of readyHooks) {
      if (aborted()) return
      try {
        await h.fn()
      } catch (e) {
        if (aborted()) return
        log.error('onReady hook failed', { module: h.moduleId, error: String(e) })
        getPeer().notify('core.notice', { level: 'error', message: `${h.moduleId} 初始化未完成：${String(e)}` })
      }
    }
  }

  /** 启动途中被叫停：先让正在跑的那一步走到下一个检查点（它看到 stopping 就收手），再拆钩子与数据库 */
  async function awaitStartupYield(budget: number): Promise<void> {
    if (starting === undefined) return
    await withTimeout(
      starting.catch(() => undefined),
      budget,
      () => new Error('startup abort timeout'),
      opts.clock,
    ).catch(() => log.warn('startup step did not yield before shutdown'))
  }

  async function startModules(): Promise<void> {
    // 0. 先建立 RPC 对端：setup 期间模块就可以 emit 通知（Host 会照常广播）
    peer = new RpcPeer({
      name: 'core',
      transport: opts.transport,
      logger: opts.logger.child({ scope: 'rpc' }),
      onRequest,
      onNotification: (method) => log.warn('unexpected notification from host', { method }),
    })
    opts.transport.onClose((reason) => {
      void shutdown(`transport closed: ${reason}`)
    })
    // 1. 模块图
    const sorted = sortModules(opts.modules)
    validateModules(sorted)
    // 2. 数据库与迁移
    db = openDatabase(opts.databaseFile)
    runMigrations(
      db,
      sorted.map((m) => ({ moduleId: m.id, migrations: m.migrations ?? [] })),
    )
    // 3. 逐个 setup（拓扑序）
    for (const m of sorted) {
      const disposables = new DisposableStore()
      moduleDisposables.push(disposables)
      const logger = opts.logger.child({ module: m.id })
      const ctx: CoreModuleContext = {
        moduleId: m.id,
        logger,
        clock: opts.clock,
        layout: opts.layout,
        db: db.forModule(m.id),
        engine: opts.engine,
        rpc: createCoreRpcBinding(m.contract, { moduleId: m.id, router, peer: getPeer, strict: opts.strict }),
        host: createHostCaller({ peer: getPeer }),
        services: registry.scoped(m.id, m.dependsOn ?? []),
        events: eventHub.scoped(m.id, m.dependsOn ?? [], logger),
        agentTools: createAgentToolRegistry(opts.engine, m.id, () => toolsFrozen),
        runtime: { coreVersion: opts.coreVersion, engineVersion: opts.engineVersion, ...opts.runtime },
        lifecycle: {
          onReady: (fn) => {
            readyHooks.push({ moduleId: m.id, fn })
          },
          onShutdown: (fn) => {
            shutdownHooks.push({ moduleId: m.id, fn })
          },
        },
        disposables,
      }
      const t0 = opts.clock.now()
      await m.setup(ctx)
      if (aborted()) return
      log.info('module ready', { module: m.id, ms: opts.clock.now() - t0 })
    }
    // 4. 每个 owner='core' 的方法都必须有实现
    assertAllCoreMethodsHandled()
    // 5. 冻结 agent 工具集
    opts.engine.freezeTools()
    toolsFrozen = true
    // 6. onReady（顺序执行；单个失败只记录并发 core.notice，不阻止启动）
    await runReadyHooks()
    if (aborted()) return
    // 7. 开始服务
    state = 'ready'
    getPeer().notify('core.ready', {
      coreVersion: opts.coreVersion,
      protocolVersion: opts.protocolVersion,
      engineVersion: opts.engineVersion,
    })
    log.info('core ready', { modules: sorted.length })
  }

  async function shutdown(reason: string): Promise<void> {
    if (state === 'stopping' || state === 'stopped') return
    const wasStarted = state !== 'created'
    const wasStarting = state === 'starting'
    state = 'stopping'
    log.info('shutting down', { reason })
    // 总截止时间：所有分阶段预算都必须从这里算，Host 的宽限期比它更长（R-05 §3.3）
    const deadline = opts.clock.now() + CORE_SHUTDOWN_BUDGET_MS
    const remaining = (cap: number): number => Math.max(0, Math.min(cap, deadline - opts.clock.now()))
    try {
      if (wasStarting) await awaitStartupYield(remaining(STARTUP_ABORT_WAIT_MS))
      await drainInflight(remaining(INFLIGHT_DRAIN_MS))
      await runShutdownHooks(remaining)
      disposeModules()
      if (wasStarted) await disposeEngine(remaining)
    } finally {
      // 数据库与 RPC 对端无论上面成败都要收掉：留着就是「进程不退出」或「库被两个进程打开」
      db?.close()
      peer?.dispose()
    }
    state = 'stopped'
    exitCode = 0
    for (const fn of exitListeners) fn(0)
  }

  /** 等手上的请求跑完；预算用完就放弃等待并记账（Core 要能硬停，不能被一个卡住的请求拖住） */
  async function drainInflight(budget: number): Promise<void> {
    if (inflight <= 0) return
    if (budget <= 0) {
      log.warn('shutdown budget exhausted, skipping inflight drain', { inflight })
      return
    }
    drained = new Deferred<void>()
    await withTimeout(drained.promise, budget, () => new Error('drain timeout'), opts.clock).catch(() =>
      log.warn('in-flight requests did not finish', { inflight }),
    )
  }

  /** 逆拓扑序串行：依赖顺序有意义，不能并发（R-05 §7） */
  async function runShutdownHooks(remaining: (cap: number) => number): Promise<void> {
    for (const h of [...shutdownHooks].reverse()) {
      const budget = remaining(SHUTDOWN_HOOK_TIMEOUT_MS)
      if (budget === 0) {
        log.warn('shutdown budget exhausted, skipping hook', { module: h.moduleId })
        continue
      }
      await withTimeout(Promise.resolve().then(h.fn), budget, () => new Error('timeout'), opts.clock).catch(
        (e: unknown) => log.warn('onShutdown hook failed', { module: h.moduleId, error: String(e) }),
      )
    }
  }

  /** 逆序释放模块占的资源：一个抛错不挡下一个 */
  function disposeModules(): void {
    for (const d of [...moduleDisposables].reverse()) {
      try {
        d.dispose()
      } catch (e) {
        log.warn('dispose failed', { error: String(e) })
      }
    }
  }

  /** 引擎释放有下限：前面把预算花光了也要给它，否则 omp 的后台进程会留成孤儿 */
  async function disposeEngine(remaining: (cap: number) => number): Promise<void> {
    const budget = Math.max(ENGINE_DISPOSE_FLOOR_MS, remaining(Number.POSITIVE_INFINITY))
    await withTimeout(opts.engine.dispose(), budget, () => new Error('engine dispose timeout'), opts.clock).catch(
      (e: unknown) => log.warn('engine dispose failed', { error: String(e) }),
    )
  }

  return {
    start,
    shutdown,
    /* 晚到的监听者（关停已经跑完）立刻收到退出码：否则 Core 在「启动途中 Host 断开」时永远不退出，成为孤儿进程 */
    onExit: (fn) => {
      if (exitCode !== null) {
        const code = exitCode
        queueMicrotask(() => fn(code))
        return
      }
      exitListeners.push(fn)
    },
    services: {
      get: registry.scoped(
        'kernel-test',
        opts.modules.map((m) => m.id),
      ).get,
    },
  }
}
