import { type Contract, SYSTEM_CONTRACT_ID } from '@poietica/contract-kit'
import { AppError, createServiceRegistry, type Disposable, SystemErrorCode, sortModules } from '@poietica/foundation'
import { BRIDGE_GLOBAL, createTypedClient, RpcPeer, type WindowBridge } from '@poietica/rpc'
import { createWindowBridgeTransport } from './bridge-transport'
import { createUiChannel, type UiChannel } from './channel'
import { ContributionRegistry } from './contribution'
import type { UiFeature, UiFeatureContext } from './feature'
import { type KernelServices, registerKernelServices } from './services'
import type { CoreStatus } from './services/core-status'
import type { Route } from './services/navigation'

export interface UiKernelOptions {
  readonly features: readonly UiFeature[]
  readonly errorMessages: Readonly<Record<string, string>>
  readonly validateResults: boolean
  readonly defaultRoute: Route
  /** 测试注入；默认 window[BRIDGE_GLOBAL] */
  readonly bridge?: WindowBridge
}

export interface UiKernel {
  start(): Promise<void>
  readonly registry: ContributionRegistry
  readonly kernelServices: KernelServices
  /** 某功能可见的服务视图（FeatureScope 用它实现 useService 的访问控制） */
  servicesFor(featureId: string): UiFeatureContext['services']
  readonly failures: ReadonlyMap<string, Error>
  dispose(): void
}

export function createUiKernel(opts: UiKernelOptions): UiKernel {
  const bridge = opts.bridge ?? (globalThis as unknown as Record<string, WindowBridge>)[BRIDGE_GLOBAL]
  if (bridge === undefined) throw new Error('preload 没有暴露 bridge：请检查 BrowserWindow 的 preload 配置')
  const registry = new ContributionRegistry()
  const services = createServiceRegistry()
  const kernelServices = registerKernelServices({
    registry,
    services,
    errorMessages: opts.errorMessages,
    defaultRoute: opts.defaultRoute,
  })
  const logger = kernelServices.logging.logger
  const transport = createWindowBridgeTransport(bridge)
  // channel 在下面的 peer 的 onNotification 里被引用：通知只会在 start() 之后到达，那时 channel 一定已赋值
  let channel: UiChannel
  const peer = new RpcPeer({
    name: 'ui',
    transport,
    logger: logger.child({ scope: 'rpc' }),
    onNotification: (m, p) => channel.dispatch(m, p),
  })
  channel = createUiChannel(peer, logger.child({ scope: 'ui-notifications' }))
  const failures = new Map<string, Error>()
  const coreReadyHooks: Array<{ featureId: string; fn: () => void | Promise<void> }> = []
  const coreLostHooks: Array<{ featureId: string; fn: () => void }> = []
  const disposeHooks: Array<() => void> = []
  const disposables: Disposable[] = []
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

  async function runCoreReady(): Promise<void> {
    for (const h of coreReadyHooks) {
      if (failures.has(h.featureId)) continue
      try {
        await h.fn()
      } catch (e) {
        logger.error('onCoreReady failed', { feature: h.featureId, error: String(e) })
        kernelServices.toasts.error(e, `${h.featureId} 数据加载失败`)
      }
    }
  }

  return {
    registry,
    kernelServices,
    failures,
    servicesFor: (featureId) => services.scoped(featureId, dependsOf.get(featureId) ?? []),
    async start() {
      for (const f of sortModules(opts.features)) {
        const deps = f.dependsOn ?? []
        dependsOf.set(f.id, deps)
        // 内核自己拥有的契约（system：core.restart / core.getStatus）任何功能都可以用，无需 dependsOn
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
            disposables.push(d)
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
              disposeHooks.push(fn)
            },
          },
        }
        try {
          f.setup(ctx)
        } catch (e) {
          const err = e instanceof Error ? e : new Error(String(e))
          failures.set(f.id, err)
          logger.error('feature setup failed', { feature: f.id, error: err.message })
        }
      }
      // Core 状态：先订阅通知，再拉一次当前值；通知比拉取结果新时以通知为准
      let notified = false
      const apply = (s: CoreStatus): void => {
        const wasReady = kernelServices.coreStatus.current().state === 'ready'
        kernelServices.coreStatus.set(s)
        /* 丢掉 Core：同步清掉依赖进程内状态的 UI 缓存，必须早于新 Core 的任何通知。 */
        if (wasReady && s.state !== 'ready') runCoreLost()
        if (s.state === 'ready' && !wasReady) void runCoreReady()
      }
      disposables.push(
        channel.subscribe('core.status', (p) => {
          notified = true
          apply(p as CoreStatus)
        }),
      )
      const initial = (await channel.request('core.getStatus', {}, { timeoutMs: 10_000 })) as CoreStatus
      if (!notified) apply(initial)
      disposables.push(kernelServices.keybindings.install(window))
    },
    dispose() {
      for (const fn of [...disposeHooks].reverse()) {
        try {
          fn()
        } catch {
          /* 忽略 */
        }
      }
      for (const d of [...disposables].reverse()) d.dispose()
      peer.dispose()
    },
  }
}

export { createWindowBridgeTransport } from './bridge-transport'
export { createUiChannel, type UiChannel } from './channel'
