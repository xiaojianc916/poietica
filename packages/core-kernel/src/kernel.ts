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
const INFLIGHT_DRAIN_MS = 1_500
/** engine.dispose 至少要拿到的时间：即使前面把预算花光了，也要给它一个下限 */
const ENGINE_DISPOSE_FLOOR_MS = 1_000

/**
 * 与 foundation 的 withTimeout 同义，但计时走**注入的 Clock**（R-05 §3.3）。
 *
 * 关停预算的截止时间是 opts.clock.now() 算的；若等待用真实 setTimeout，测试注入的
 * 假时钟推不动它们，这条路径就没法确定地验收。生产里 clock 就是 systemClock，
 * 两者是同一个东西。
 */
function withClockTimeout<T>(clock: Clock, promise: Promise<T>, ms: number, onTimeout: () => Error): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = clock.setTimeout(() => reject(onTimeout()), ms)
    promise.then(
      (value) => {
        timer.dispose()
        resolve(value)
      },
      (error: unknown) => {
        timer.dispose()
        reject(error)
      },
    )
  })
}

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

  async function start(): Promise<void> {
    if (state !== 'created') throw new AppError(SystemErrorCode.conflict, 'start() 只能调用一次')
    state = 'starting'
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
      log.info('module ready', { module: m.id, ms: opts.clock.now() - t0 })
    }
    // 4. 每个 owner='core' 的方法都必须有实现
    assertAllCoreMethodsHandled()
    // 5. 冻结 agent 工具集
    opts.engine.freezeTools()
    toolsFrozen = true
    // 6. onReady（顺序执行；单个失败只记录并发 core.notice，不阻止启动）
    for (const h of readyHooks) {
      try {
        await h.fn()
      } catch (e) {
        log.error('onReady hook failed', { module: h.moduleId, error: String(e) })
        getPeer().notify('core.notice', { level: 'error', message: `${h.moduleId} 初始化未完成：${String(e)}` })
      }
    }
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
    state = 'stopping'
    log.info('shutting down', { reason })
    // 总截止时间：所有分阶段预算都必须从这里算，Host 的宽限期比它更长（R-05 §3.3）
    const deadline = opts.clock.now() + CORE_SHUTDOWN_BUDGET_MS
    const remaining = (cap: number): number => Math.max(0, Math.min(cap, deadline - opts.clock.now()))
    try {
      if (inflight > 0) {
        const budget = remaining(INFLIGHT_DRAIN_MS)
        if (budget > 0) {
          drained = new Deferred<void>()
          await withClockTimeout(opts.clock, drained.promise, budget, () => new Error('drain timeout')).catch(() =>
            log.warn('in-flight requests did not finish', { inflight }),
          )
        } else {
          log.warn('shutdown budget exhausted, skipping inflight drain', { inflight })
        }
      }
      // 逆拓扑序串行：依赖顺序有意义，不能并发（R-05 §7）
      for (const h of [...shutdownHooks].reverse()) {
        const budget = remaining(SHUTDOWN_HOOK_TIMEOUT_MS)
        if (budget === 0) {
          log.warn('shutdown budget exhausted, skipping hook', { module: h.moduleId })
          continue
        }
        await withClockTimeout(opts.clock, Promise.resolve().then(h.fn), budget, () => new Error('timeout')).catch(
          (e: unknown) => log.warn('onShutdown hook failed', { module: h.moduleId, error: String(e) }),
        )
      }
      for (const d of [...moduleDisposables].reverse()) {
        try {
          d.dispose()
        } catch (e) {
          log.warn('dispose failed', { error: String(e) })
        }
      }
      if (wasStarted) {
        const budget = Math.max(ENGINE_DISPOSE_FLOOR_MS, remaining(Number.POSITIVE_INFINITY))
        await withClockTimeout(
          opts.clock,
          opts.engine.dispose(),
          budget,
          () => new Error('engine dispose timeout'),
        ).catch((e: unknown) => log.warn('engine dispose failed', { error: String(e) }))
      }
    } finally {
      // 数据库与 RPC 对端无论上面成败都要收掉：留着就是「进程不退出」或「库被两个进程打开」
      db?.close()
      peer?.dispose()
    }
    state = 'stopped'
    for (const fn of exitListeners) fn(0)
  }

  return {
    start,
    shutdown,
    onExit: (fn) => {
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
