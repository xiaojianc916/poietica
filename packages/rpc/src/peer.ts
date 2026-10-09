import { AppError, type Disposable, type Logger, SystemErrorCode, toAppError } from '@poietica/foundation'
import {
  CANCEL_METHOD,
  type ErrorObject,
  isNotification,
  isRequest,
  type RpcId,
  type RpcMessage,
  type RpcMeta,
} from './messages'
import type { Transport } from './transport'

export interface InboundContext {
  readonly id: RpcId
  readonly signal: AbortSignal
  readonly meta: RpcMeta | undefined
}
export type RequestHandler = (method: string, params: unknown, ctx: InboundContext) => Promise<unknown>
export type NotificationHandler = (method: string, params: unknown) => void
export interface RequestOptions {
  readonly timeoutMs?: number
  readonly signal?: AbortSignal
  readonly meta?: RpcMeta
}

export interface RpcPeerOptions {
  readonly name: string // 日志用，例如 'ui'、'host→core'、'core'
  readonly transport: Transport
  readonly logger: Logger
  readonly onRequest?: RequestHandler // 未提供：一律回 method_not_found
  readonly onNotification?: NotificationHandler
  readonly defaultTimeoutMs?: number // 默认 30_000
}

interface Pending {
  resolve(v: unknown): void
  reject(e: AppError): void
  timer: ReturnType<typeof setTimeout> | undefined
  cleanup(): void
}

export class RpcPeer implements Disposable {
  private nextId = 1
  private closed: string | null = null
  private readonly pending = new Map<RpcId, Pending>()
  private readonly inbound = new Map<RpcId, AbortController>()
  private readonly subs: Disposable[]

  constructor(private readonly o: RpcPeerOptions) {
    this.subs = [
      o.transport.onMessage((m) => this.receive(m)),
      o.transport.onClose((reason) => this.handleClose(reason)),
    ]
  }

  request(method: string, params: unknown, opts: RequestOptions = {}): Promise<unknown> {
    if (this.closed !== null)
      return Promise.reject(new AppError(SystemErrorCode.coreUnavailable, `连接已关闭：${this.closed}`))
    if (opts.signal?.aborted === true) return Promise.reject(new AppError(SystemErrorCode.cancelled, '请求已取消'))
    const id = this.nextId++
    return new Promise<unknown>((resolve, reject) => {
      const timeoutMs = opts.timeoutMs ?? this.o.defaultTimeoutMs ?? 30_000
      const onAbort = (): void => {
        this.sendCancel(id)
        this.settle(id, new AppError(SystemErrorCode.cancelled, '请求已取消'))
      }
      const p: Pending = {
        resolve,
        reject,
        timer:
          timeoutMs > 0
            ? setTimeout(() => {
                this.sendCancel(id)
                this.settle(id, new AppError(SystemErrorCode.timeout, `${method} 超时（${timeoutMs}ms）`))
              }, timeoutMs)
            : undefined,
        cleanup: () => opts.signal?.removeEventListener('abort', onAbort),
      }
      this.pending.set(id, p)
      opts.signal?.addEventListener('abort', onAbort, { once: true })
      this.o.transport.send({
        jsonrpc: '2.0',
        id,
        method,
        params,
        ...(opts.meta === undefined ? {} : { meta: opts.meta }),
      })
    })
  }

  notify(method: string, params: unknown): void {
    if (this.closed !== null) return
    this.o.transport.send({ jsonrpc: '2.0', method, params })
  }

  dispose(): void {
    for (const s of this.subs) s.dispose()
    this.handleClose('disposed')
  }

  private sendCancel(id: RpcId): void {
    this.notify(CANCEL_METHOD, { id })
  }

  private settle(id: RpcId, outcome: AppError | { result: unknown }): void {
    const p = this.pending.get(id)
    if (p === undefined) return
    this.pending.delete(id)
    if (p.timer !== undefined) clearTimeout(p.timer)
    p.cleanup()
    if (outcome instanceof AppError) p.reject(outcome)
    else p.resolve(outcome.result)
  }

  private receive(m: RpcMessage): void {
    if (isRequest(m)) {
      void this.handleRequest(m.id, m.method, m.params, m.meta)
      return
    }
    if (isNotification(m)) {
      if (m.method === CANCEL_METHOD) {
        this.inbound.get((m.params as { id: RpcId }).id)?.abort()
        return
      }
      try {
        this.o.onNotification?.(m.method, m.params)
      } catch (e) {
        this.o.logger.error('notification handler threw', { method: m.method, error: String(e) })
      }
      return
    }
    if ('result' in m) this.settle(m.id, { result: m.result })
    else if (m.id !== null) this.settle(m.id, fromErrorObject(m.error))
  }

  private async handleRequest(id: RpcId, method: string, params: unknown, meta: RpcMeta | undefined): Promise<void> {
    const ac = new AbortController()
    this.inbound.set(id, ac)
    try {
      if (this.o.onRequest === undefined) throw new AppError(SystemErrorCode.methodNotFound, `未知方法 ${method}`)
      const result = await this.o.onRequest(method, params, { id, signal: ac.signal, meta })
      if (this.closed === null) this.o.transport.send({ jsonrpc: '2.0', id, result: result ?? null })
    } catch (e) {
      const err = ac.signal.aborted ? new AppError(SystemErrorCode.cancelled, '请求已取消') : toAppError(e)
      /*
       * 非 AppError 一律折成 kernel.internal（铁律 5 的兜底）。折的过程会换掉 Error 实例，
       * 原始 stack 因此必须在这里留下来 —— 否则「handler 里到底哪一行写的裸 Error」就查不到了。
       */
      if (err.code === SystemErrorCode.internal) {
        this.o.logger.error('request failed', {
          method,
          error: err.message,
          ...(e instanceof Error && e.stack !== undefined ? { stack: e.stack } : {}),
        })
      }
      if (this.closed === null) this.o.transport.send({ jsonrpc: '2.0', id, error: toErrorObject(err) })
    } finally {
      this.inbound.delete(id)
    }
  }

  private handleClose(reason: string): void {
    if (this.closed !== null) return
    this.closed = reason
    for (const ac of this.inbound.values()) ac.abort()
    for (const id of [...this.pending.keys()])
      this.settle(id, new AppError(SystemErrorCode.coreUnavailable, `连接已关闭：${reason}`))
  }
}

export function toErrorObject(e: AppError): ErrorObject {
  const code =
    e.code === SystemErrorCode.methodNotFound ? -32601 : e.code === SystemErrorCode.invalidParams ? -32602 : -32000
  return { code, message: e.message, data: e.toJSON() }
}
export function fromErrorObject(o: ErrorObject): AppError {
  return new AppError(o.data?.code ?? SystemErrorCode.internal, o.message, o.data?.data)
}
