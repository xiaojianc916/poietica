import type { Disposable } from '@poietica/foundation'
import type { RpcMessage, Transport, WindowBridge } from '@poietica/rpc'

export function createWindowBridgeTransport(bridge: WindowBridge): Transport {
  const messageListeners = new Set<(m: RpcMessage) => void>()
  const closeListeners = new Set<(reason: string) => void>()
  let closed = false
  const off = bridge.onMessage((m) => {
    if (!closed) for (const l of [...messageListeners]) l(m)
  })
  const sub = <T>(set: Set<T>, l: T): Disposable => {
    set.add(l)
    return {
      dispose: () => {
        set.delete(l)
      },
    }
  }
  return {
    send: (m) => {
      if (!closed) bridge.send(m)
    },
    onMessage: (l) => sub(messageListeners, l),
    onClose: (l) => sub(closeListeners, l),
    close: (reason) => {
      if (closed) return
      closed = true
      off()
      for (const l of [...closeListeners]) l(reason)
    },
  }
}
