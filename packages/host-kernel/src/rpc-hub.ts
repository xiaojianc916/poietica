import type {
  AppContract,
  Contract,
  MethodName,
  NotificationName,
  NotificationParams,
  ParamsIn,
  ResultOf,
} from '@poietica/contract-kit'
import { AppError, createId, type Disposable, type Logger, SystemErrorCode } from '@poietica/foundation'
import { type InboundContext, type Router, RpcPeer, type Transport } from '@poietica/rpc'
import type { CoreSupervisor } from './core-supervisor'
import type { CoreCaller } from './module'

/** 只需要 webContents 的这几个能力；测试中用假对象 */
export interface HubWebContents {
  readonly id: number
  on(
    event: 'did-start-navigation',
    listener: (details: { isMainFrame: boolean; isSameDocument: boolean }) => void,
  ): unknown
  once(event: 'destroyed', listener: () => void): unknown
}

export interface RpcHubOptions {
  readonly appContract: AppContract
  readonly hostRouter: Router
  readonly supervisor: Pick<CoreSupervisor, 'forward' | 'status' | 'onStatus' | 'relayPort'>
  readonly logger: Logger
  /** 生产环境传 createIpcTransport；测试传入返回 transportPair 一端的函数 */
  readonly createTransport: (wc: HubWebContents) => Transport
}

export class RpcHub {
  private readonly windows = new Map<number, RpcPeer>()
  private readonly coreListeners = new Map<string, Set<(params: unknown) => void>>()

  constructor(private readonly o: RpcHubOptions) {}

  attachWindow(wc: HubWebContents): void {
    const connect = (): void => {
      this.windows.get(wc.id)?.dispose()
      const transport = this.o.createTransport(wc)
      const peer = new RpcPeer({
        name: `ui#${wc.id}`,
        transport,
        logger: this.o.logger,
        onRequest: (method, params, ctx) => this.route(method, params, ctx),
        onNotification: (method) => this.o.logger.warn('unexpected notification from ui', { method }),
        defaultTimeoutMs: 30_000,
      })
      this.windows.set(wc.id, peer)
    }
    connect()
    // 页面重新加载（开发时 F5、渲染进程崩溃后重载）：旧页面的请求 id 作废，换一个新的对端
    wc.on('did-start-navigation', (d) => {
      if (d.isMainFrame && !d.isSameDocument) connect()
    })
    wc.once('destroyed', () => {
      this.windows.get(wc.id)?.dispose()
      this.windows.delete(wc.id)
    })
  }

  broadcast(method: string, params: unknown): void {
    for (const peer of this.windows.values()) peer.notify(method, params)
  }

  /** Core 发来的通知：先给 Host 模块旁听，再广播给窗口（core.ready 由 supervisor 消费，不会到这里） */
  fromCore(method: string, params: unknown): void {
    for (const l of [...(this.coreListeners.get(method) ?? [])]) {
      try {
        l(params)
      } catch (e) {
        this.o.logger.error('core notification listener threw', { method, error: String(e) })
      }
    }
    this.broadcast(method, params)
  }

  /** Core 发来的请求：只允许 owner='host' 的方法 */
  async handleFromCore(method: string, params: unknown, ctx: InboundContext): Promise<unknown> {
    const def = this.o.appContract.methods.get(method)
    if (def === undefined || def.owner !== 'host') {
      throw new AppError(SystemErrorCode.methodNotFound, `Core 不能调用 ${method}`)
    }
    return this.o.hostRouter.handle(method, params, ctx)
  }

  coreCaller(): CoreCaller {
    return {
      call: async <C extends Contract, N extends MethodName<C>>(
        contract: C,
        name: N,
        params: ParamsIn<C, N>,
        opts?: { signal?: AbortSignal; timeoutMs?: number },
      ) => {
        const def = contract.methods.find((m) => m.name === name)
        if (def === undefined || def.owner !== 'core') {
          throw new AppError(SystemErrorCode.methodNotFound, `${String(name)} 不是 owner='core' 的方法`)
        }
        const ac = new AbortController()
        const timeoutMs = opts?.timeoutMs ?? def.timeoutMs
        const timer = timeoutMs > 0 ? setTimeout(() => ac.abort(), timeoutMs) : undefined
        opts?.signal?.addEventListener('abort', () => ac.abort(), { once: true })
        try {
          const raw = await this.o.supervisor.forward(def.name, def.params.parse(params), {
            signal: ac.signal,
            meta: { traceId: createId(), origin: 'host' },
          })
          return def.result.parse(raw) as ResultOf<C, N>
        } catch (e) {
          if (ac.signal.aborted && !(opts?.signal?.aborted ?? false)) {
            throw new AppError(SystemErrorCode.timeout, `${def.name} 超时（${timeoutMs}ms）`)
          }
          throw e
        } finally {
          if (timer !== undefined) clearTimeout(timer)
        }
      },
      on: <C extends Contract, N extends NotificationName<C>>(
        contract: C,
        name: N,
        listener: (p: NotificationParams<C, N>) => void,
      ): Disposable => {
        const def = contract.notifications.find((n) => n.name === name)
        if (def === undefined || def.owner !== 'core') {
          throw new AppError(SystemErrorCode.methodNotFound, `${String(name)} 不是 owner='core' 的通知`)
        }
        const set = this.coreListeners.get(def.name) ?? new Set()
        this.coreListeners.set(def.name, set)
        const l = (raw: unknown): void => listener(def.params.parse(raw) as NotificationParams<C, N>)
        set.add(l)
        return {
          dispose: () => {
            set.delete(l)
          },
        }
      },
      status: () => this.o.supervisor.status,
      onStatus: (l) => this.o.supervisor.onStatus(l),
      relayPort: () => this.o.supervisor.relayPort(),
    }
  }

  private async route(method: string, params: unknown, ctx: InboundContext): Promise<unknown> {
    const def = this.o.appContract.methods.get(method)
    if (def === undefined) throw new AppError(SystemErrorCode.methodNotFound, `未知方法 ${method}`)
    if (def.owner === 'host') return this.o.hostRouter.handle(method, params, ctx)
    // owner='core'：Hub 不设超时（timeoutMs=0），由 UI 侧超时后发送 $/cancelRequest，ctx.signal 随之中止并转发取消
    return this.o.supervisor.forward(method, params, { signal: ctx.signal, meta: ctx.meta })
  }
}
