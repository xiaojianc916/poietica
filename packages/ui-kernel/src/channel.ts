import { createId, type Disposable, type Logger } from '@poietica/foundation'
import type { RpcChannel, RpcPeer } from '@poietica/rpc'

export interface UiChannel extends RpcChannel {
  dispatch(method: string, params: unknown): void
}

export function createUiChannel(peer: RpcPeer, logger: Logger): UiChannel {
  const listeners = new Map<string, Set<(params: unknown) => void>>()
  return {
    request: (method, params, opts) =>
      peer.request(method, params, {
        timeoutMs: opts.timeoutMs,
        ...(opts.signal === undefined ? {} : { signal: opts.signal }),
        meta: { traceId: createId(), origin: 'ui' },
      }),
    subscribe(name, listener): Disposable {
      const set = listeners.get(name) ?? new Set()
      listeners.set(name, set)
      set.add(listener)
      return {
        dispose: () => {
          set.delete(listener)
        },
      }
    },
    dispatch(method, params) {
      for (const l of [...(listeners.get(method) ?? [])]) {
        try {
          l(params)
        } catch (e) {
          logger.error('通知监听器抛错', { method, error: String(e) })
        }
      }
    },
  }
}
