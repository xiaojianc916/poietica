import type {
  AppContract,
  Caller,
  Contract,
  MethodName,
  NotificationName,
  NotificationParams,
  ParamsIn,
  ResultOf,
} from '@poietica/contract-kit'
import { AppError, createId, type Disposable, type Logger, SystemErrorCode } from '@poietica/foundation'
import { type InboundContext, jsonValue, type Router, RpcPeer, type Transport } from '@poietica/rpc'
import type { CoreSupervisor } from './core-supervisor'
import type { CoreCaller } from './module'

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
  readonly supervisor: Pick<CoreSupervisor, 'forward' | 'status' | 'onStatus'>
  readonly logger: Logger
  /** 生产环境传 createIpcTransport；测试传入返回 transportPair 一端的函数。 */
  readonly createTransport: (wc: HubWebContents) => Transport
}

function rethrowOnTimeout(
  e: unknown,
  aborted: boolean,
  callerAborted: boolean,
  name: string,
  timeoutMs: number,
): never {
  if (aborted && !callerAborted) throw new AppError(SystemErrorCode.timeout, `${name} 超时（${timeoutMs}ms）`)
  throw e
}

export class RpcHub {
  private readonly windows = new Map<number, RpcPeer>()
  private readonly coreListeners = new Map<string, Set<(params: unknown) => void>>()
  /** 窗口 → 已订阅的时间线主题；窗口重载时清空（ADR-006 的主题路由） */
  private readonly topics = new Map<number, Set<string>>()

  constructor(private readonly o: RpcHubOptions) {}

  attachWindow(wc: HubWebContents): void {
    const connect = (): void => {
      this.windows.get(wc.id)?.dispose()
      const transport = this.o.createTransport(wc)
      const peer = new RpcPeer({
        name: `ui#${wc.id}`,
        transport,
        logger: this.o.logger,
        onRequest: (method, params, ctx) => this.route(method, params, ctx, wc.id),
        onNotification: (method) => this.o.logger.warn('unexpected notification from ui', { method }),
        defaultTimeoutMs: 30_000,
      })
      this.windows.set(wc.id, peer)
    }
    connect()
    // 页面重新加载（开发时 F5、渲染进程崩溃后重载）：旧页面的请求 id 作废，换一个新的对端
    wc.on('did-start-navigation', (d) => {
      if (d.isMainFrame && !d.isSameDocument) {
        this.topics.delete(wc.id)
        connect()
      }
    })
    wc.once('destroyed', () => {
      this.windows.get(wc.id)?.dispose()
      this.windows.delete(wc.id)
      this.topics.delete(wc.id)
    })
  }

  broadcast(method: string, params: unknown): void {
    for (const peer of this.windows.values()) peer.notify(method, params)
  }

  /**
   * Core 发来的通知：先给 Host 模块旁听，再广播给窗口（core.ready 由 supervisor 消费，不会到这里）。
   * params 是 RawJson（rpc/frame-bytes.ts）：只有真有 Host 模块旁听时才解析，广播给窗口的是原样的 JSON 文本。
   */
  fromCore(method: string, params: unknown): void {
    const listeners = this.coreListeners.get(method)
    if (listeners !== undefined && listeners.size > 0) {
      for (const l of [...listeners]) {
        try {
          l(jsonValue(params))
        } catch (e) {
          this.o.logger.error('core notification listener threw', { method, error: String(e) })
        }
      }
    }
    const key = notificationTopic(method, params)
    if (key !== null && this.routeToTopic(key, method, params)) return
    /* 还没有窗口登记这个主题（例如新终端的第一段输出、侧边面板尚未挂载）：保持旧的广播回退，避免丢首帧。 */
    this.broadcast(method, params)
  }

  /** 流通知只发给订阅了该主题的窗口；Host 只读信封里的主题键，不碰载荷。 */
  private routeToTopic(key: string, method: string, params: unknown): boolean {
    let routed = false
    for (const [id, topics] of this.topics) {
      if (!topics.has(key)) continue
      const peer = this.windows.get(id)
      if (peer === undefined) continue
      peer.notify(method, params)
      routed = true
    }
    return routed
  }

  /** Core 发来的请求：只允许 owner='host' 的方法 */
  async handleFromCore(method: string, params: unknown, ctx: InboundContext): Promise<unknown> {
    const def = this.o.appContract.methods.get(method)
    if (def === undefined || def.owner !== 'host' || !callerAllowed(def, 'core')) {
      throw new AppError(SystemErrorCode.methodNotFound, `Core 不能调用 ${method}`)
    }
    return this.o.hostRouter.handle(method, jsonValue(params), ctx)
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
        if (!callerAllowed(def, 'host')) {
          throw new AppError(SystemErrorCode.methodNotFound, `Host 不能调用 ${String(name)}`)
        }
        const ac = new AbortController()
        const timeoutMs = opts?.timeoutMs ?? def.timeoutMs
        const timer = timeoutMs > 0 ? setTimeout(() => ac.abort(), timeoutMs) : undefined
        /* 调用方可能拿一个**长寿** signal 反复调用（R-08-10）：监听器必须摘掉，否则监听器与闭包单调累积。 */
        const onAbort = (): void => ac.abort()
        if (opts?.signal?.aborted === true) ac.abort()
        else opts?.signal?.addEventListener('abort', onAbort, { once: true })
        try {
          const raw = await this.o.supervisor.forward(def.name, def.params.parse(params), {
            signal: ac.signal,
            meta: { traceId: createId(), origin: 'host' },
          })
          return def.result.parse(jsonValue(raw)) as ResultOf<C, N>
        } catch (e) {
          rethrowOnTimeout(e, ac.signal.aborted, opts?.signal?.aborted ?? false, def.name, timeoutMs)
        } finally {
          if (timer !== undefined) clearTimeout(timer)
          opts?.signal?.removeEventListener('abort', onAbort)
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
    }
  }

  private async route(method: string, params: unknown, ctx: InboundContext, windowId: number): Promise<unknown> {
    const def = this.o.appContract.methods.get(method)
    if (def === undefined) throw new AppError(SystemErrorCode.methodNotFound, `未知方法 ${method}`)
    /* 声明了调用方而不含 ui 的方法（例如 secrets.*）对窗口等同不存在：不告诉它有这个方法 */
    if (!callerAllowed(def, 'ui')) throw new AppError(SystemErrorCode.methodNotFound, `未知方法 ${method}`)
    const subscription = subscriptionTopic(method, params)
    if (subscription !== null) {
      const topics = this.topics.get(windowId) ?? new Set<string>()
      if (subscription.subscribe) topics.add(subscription.key)
      else topics.delete(subscription.key)
      this.topics.set(windowId, topics)
      /* 终端/侧边的订阅只是 Host 的传输登记，没有 Core 侧动作。 */
      if (subscription.hostOnly) return {}
    }
    if (def.owner === 'host') return this.o.hostRouter.handle(method, params, ctx)
    // owner='core'：Hub 不设超时（timeoutMs=0），UI 侧超时后发 $/cancelRequest，ctx.signal 随之中止并转发取消。
    // 结果是 RawJson，原样交回给窗口的对端：Host 不解析、不重编码（ipc-transport 发成「信封 + 载荷文本」）。
    return this.o.supervisor.forward(method, params, { signal: ctx.signal, meta: ctx.meta })
  }
}

function objectOf(params: unknown): Record<string, unknown> | null {
  const value = typeof params === 'string' ? jsonValue(params) : params
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null
}

function stringField(value: Record<string, unknown>, key: string): string | null {
  const field = Reflect.get(value, key)
  return typeof field === 'string' ? field : null
}

/** 订阅方法 → 主题键；不是订阅方法交 null。 */
const TRANSPORT_ONLY_HOST_METHODS = new Set([
  'terminal.subscribe',
  'terminal.unsubscribe',
  'side.subscribe',
  'side.unsubscribe',
])

/** 这些 Host 方法由 RpcHub 的窗口主题登记直接处理，不需要模块注册 handler。 */
export function isTransportOnlyHostMethod(method: string): boolean {
  return TRANSPORT_ONLY_HOST_METHODS.has(method)
}

export function missingHostMethods(appContract: AppContract, has: (name: string) => boolean): string[] {
  return [...appContract.methods.values()]
    .filter((d) => d.owner === 'host' && !isTransportOnlyHostMethod(d.name) && !has(d.name))
    .map((d) => d.name)
}

function subscriptionTopic(
  method: string,
  params: unknown,
): { key: string; subscribe: boolean; hostOnly: boolean } | null {
  const value = objectOf(params)
  if (value === null) return null
  if (method === 'timeline.subscribe' || method === 'timeline.unsubscribe') {
    const threadId = stringField(value, 'threadId')
    const agentId = stringField(value, 'agentId')
    if (threadId === null || agentId === null) return null
    return {
      key: `timeline\u0000${threadId}\u0000${agentId}`,
      subscribe: method.endsWith('subscribe'),
      hostOnly: false,
    }
  }
  if (method === 'terminal.subscribe' || method === 'terminal.unsubscribe') {
    const terminalId = stringField(value, 'terminalId')
    if (terminalId === null) return null
    return { key: `terminal\u0000${terminalId}`, subscribe: method.endsWith('subscribe'), hostOnly: true }
  }
  if (method === 'side.subscribe' || method === 'side.unsubscribe') {
    const threadId = stringField(value, 'threadId')
    const topicId = stringField(value, 'topicId')
    if (threadId === null || topicId === null) return null
    return { key: `side\u0000${threadId}\u0000${topicId}`, subscribe: method.endsWith('subscribe'), hostOnly: true }
  }
  return null
}

/** 通知 → 主题键；不按主题路由的通知交 null。 */
function notificationTopic(method: string, params: unknown): string | null {
  const value = objectOf(params)
  if (value === null) return null
  if (method === 'timeline.events' || method === 'timeline.reset') {
    const threadId = stringField(value, 'threadId')
    const agentId = stringField(value, 'agentId')
    return threadId === null || agentId === null ? null : `timeline\u0000${threadId}\u0000${agentId}`
  }
  if (method === 'terminal.output' || method === 'terminal.exited') {
    const terminalId = stringField(value, 'terminalId')
    return terminalId === null ? null : `terminal\u0000${terminalId}`
  }
  if (method === 'side.delta') {
    const threadId = stringField(value, 'threadId')
    const topicId = stringField(value, 'topicId')
    return threadId === null || topicId === null ? null : `side\u0000${threadId}\u0000${topicId}`
  }
  return null
}

/** 契约里没写 callers 就不限调用方 */
function callerAllowed(def: { readonly callers?: readonly Caller[] }, caller: Caller): boolean {
  return def.callers === undefined || def.callers.includes(caller)
}
