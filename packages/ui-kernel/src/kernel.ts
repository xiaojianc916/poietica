import { type Contract, SYSTEM_CONTRACT_ID } from '@poietica/contract-kit'
import { AppError, createServiceRegistry, DisposableStore, SystemErrorCode, sortModules } from '@poietica/foundation'
import {
  BRIDGE_GLOBAL,
  createTypedClient,
  type PreloadBridge,
  RpcPeer,
  type WindowBridge,
  windowBridgeFromPreload,
} from '@poietica/rpc'
import { createWindowBridgeTransport } from './bridge-transport'
import { createUiChannel, type UiChannel } from './channel'
import { ContributionRegistry } from './contribution'
import type { CoreReadyContext, UiFeature, UiFeatureContext } from './feature'
import { type KernelServices, registerKernelServices } from './services'
import type { CoreStatus } from './services/core-status'
import type { Route } from './services/navigation'

export interface UiKernelOptions {
  readonly features: readonly UiFeature[]
  readonly errorMessages: Readonly<Record<string, string>>
  readonly validateResults: boolean
  readonly defaultRoute: Route
  /** 测试注入用。 */
  readonly bridge?: WindowBridge
}

export interface UiKernel {
  start(): Promise<void>
  readonly registry: ContributionRegistry
  readonly kernelServices: KernelServices
  servicesFor(featureId: string): UiFeatureContext['services']
  readonly failures: ReadonlyMap<string, Error>
  dispose(): void
}

export function createUiKernel(opts: UiKernelOptions): UiKernel {
  const preload = (globalThis as unknown as Record<string, PreloadBridge | undefined>)[BRIDGE_GLOBAL]
  if (opts.bridge === undefined && preload === undefined) {
    throw new Error('preload 没有暴露 bridge：请检查 BrowserWindow 的 preload 配置')
  }
  const registry = new ContributionRegistry()
  const services = createServiceRegistry()
  const kernelServices = registerKernelServices({
    registry,
    services,
    errorMessages: opts.errorMessages,
    defaultRoute: opts.defaultRoute,
  })
  const logger = kernelServices.logging.logger
  const bridge: WindowBridge =
    opts.bridge ??
    windowBridgeFromPreload(preload as PreloadBridge, (sample) =>
      logger.warn('丢弃一条无法解析的 Host 消息', { sample }),
    )
  const transport = createWindowBridgeTransport(bridge)
  // channel 只会在 start() 之后被通知引用，那时一定已赋值
  let channel: UiChannel
  const peer = new RpcPeer({
    name: 'ui',
    transport,
    logger: logger.child({ scope: 'rpc' }),
    onNotification: (m, p) => channel.dispatch(m, p),
  })
  channel = createUiChannel(peer, logger.child({ scope: 'ui-notifications' }))
  const failures = new Map<string, Error>()
  const coreReadyHooks: Array<{ featureId: string; fn: (scope: CoreReadyContext) => void | Promise<void> }> = []
  const coreLostHooks: Array<{ featureId: string; fn: () => void }> = []
  const featureResources = new Map<string, DisposableStore>()
  const disposables = new DisposableStore()
  let state: 'created' | 'starting' | 'started' | 'disposed' = 'created'
  let readyScope: AbortController | undefined

  function releaseFeature(featureId: string, resources: DisposableStore): void {
    try {
      resources.dispose()
    } catch (e) {
      logger.warn('功能资源释放失败', { feature: featureId, error: String(e) })
    } finally {
      services.revoke(featureId)
    }
  }

  function invalidateReady(): void {
    readyScope?.abort()
    readyScope = undefined
  }
  const dependsOf = new Map<string, readonly string[]>()

  function runCoreLost(): void {
    for (const h of coreLostHooks) {
      if (failures.has(h.featureId)) continue
      try {
        h.fn()
      } catch (e) {
        logger.error('onCoreLost failed', { feature: h.featureId, error: String(e) })
      }
    }
  }

  /**
   * 每个功能的多个 onCoreReady 钩子**按注册顺序串行**（功能内部的前后关系只有它自己知道），
   * 功能之间**并行**（R-08-9）—— 一个功能的慢请求不该把后面所有功能的首屏数据都压住。
   * 先注册只是先起步，不保证先完成。
   */
  async function runCoreReady(signal: AbortSignal): Promise<void> {
    const groups = new Map<string, Array<(typeof coreReadyHooks)[number]>>()
    for (const h of coreReadyHooks) {
      const list = groups.get(h.featureId)
      if (list === undefined) groups.set(h.featureId, [h])
      else list.push(h)
    }
    await Promise.all(
      [...groups.values()].map(async (hooks) => {
        for (const h of hooks) {
          if (signal.aborted || failures.has(h.featureId)) return
          try {
            await h.fn({ signal })
          } catch (e) {
            if (signal.aborted) return
            logger.error('onCoreReady failed', { feature: h.featureId, error: String(e) })
            kernelServices.banners.error(e, `${h.featureId} 数据加载失败`)
          }
        }
      }),
    )
  }

  function setupFeature(f: UiFeature): void {
    const deps = f.dependsOn ?? []
    dependsOf.set(f.id, deps)
    const failedDependency = deps.find((id) => failures.has(id))
    if (failedDependency !== undefined) {
      failures.set(f.id, new AppError(SystemErrorCode.serviceAccessDenied, `依赖功能 ${failedDependency} 启动失败`))
      services.revoke(f.id)
      return
    }
    const resources = new DisposableStore()
    featureResources.set(f.id, resources)
    // 内核自己的契约（system）任何功能都可以用，无需 dependsOn
    const allowedContracts = new Set([f.id, SYSTEM_CONTRACT_ID, ...deps])
    const ctx: UiFeatureContext = {
      featureId: f.id,
      logger: logger.child({ feature: f.id }),
      rpc: <C extends Contract>(contract: C) => {
        if (!allowedContracts.has(contract.id)) {
          throw new AppError(
            SystemErrorCode.serviceAccessDenied,
            `${f.id} 使用 ${contract.id} 的契约前必须在 dependsOn 中声明 '${contract.id}'`,
          )
        }
        return createTypedClient(contract, channel, { validateResults: opts.validateResults })
      },
      services: services.scoped(f.id, deps),
      contribute: (point, item) => {
        const d = registry.add(point, f.id, item)
        resources.add(d)
        return d
      },
      files: { pathForFile: (file) => bridge.pathForFile(file) },
      lifecycle: {
        onCoreReady: (fn) => {
          coreReadyHooks.push({ featureId: f.id, fn })
        },
        onCoreLost: (fn) => {
          coreLostHooks.push({ featureId: f.id, fn })
        },
        onDispose: (fn) => {
          resources.add({ dispose: fn })
        },
      },
    }
    try {
      f.setup(ctx)
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e))
      failures.set(f.id, err)
      releaseFeature(f.id, resources)
      logger.error('feature setup failed', { feature: f.id, error: err.message })
    }
  }

  return {
    registry,
    kernelServices,
    failures,
    servicesFor: (featureId) => services.scoped(featureId, dependsOf.get(featureId) ?? []),
    async start() {
      if (state !== 'created') throw new AppError(SystemErrorCode.conflict, 'UI 内核只能启动一次且不能在释放后启动')
      state = 'starting'
      for (const f of sortModules(opts.features)) setupFeature(f)
      // Core 状态：先订阅通知，再拉一次当前值；通知比拉取结果新时以通知为准
      let notified = false
      const apply = (s: CoreStatus): void => {
        if (state === 'disposed') return
        const wasReady = kernelServices.coreStatus.current().state === 'ready'
        if (s.state !== 'ready') invalidateReady()
        kernelServices.coreStatus.set(s)
        /* 丢掉 Core：同步清掉依赖进程内状态的 UI 缓存，必须早于新 Core 的任何通知。 */
        if (wasReady && s.state !== 'ready') runCoreLost()
        if (s.state === 'ready' && !wasReady) {
          readyScope = new AbortController()
          void runCoreReady(readyScope.signal)
        }
      }
      disposables.add(
        channel.subscribe('core.status', (p) => {
          notified = true
          apply(p as CoreStatus)
        }),
      )
      const initial = (await channel.request('core.getStatus', {}, { timeoutMs: 10_000 })) as CoreStatus
      if (disposables.isDisposed) return
      if (!notified) apply(initial)
      state = 'started'
      disposables.add(kernelServices.keybindings.install(window))
    },
    dispose() {
      if (state === 'disposed') return
      state = 'disposed'
      invalidateReady()
      for (const [featureId, resources] of [...featureResources].reverse()) releaseFeature(featureId, resources)
      try {
        disposables.dispose()
      } catch (e) {
        logger.warn('内核资源释放失败', { error: String(e) })
      } finally {
        peer.dispose()
      }
    },
  }
}

export { createWindowBridgeTransport } from './bridge-transport'
export { createUiChannel, type UiChannel } from './channel'
