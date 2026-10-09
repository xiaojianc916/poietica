import { type Disposable, Emitter } from '@poietica/foundation'
import type { RpcMessage, Transport } from '@poietica/rpc'

/**
 * 一对互相连接的内存传输。消息经 JSON 往返（模拟 stdio 的序列化：undefined 字段丢失、Date 变字符串），
 * 并通过 queueMicrotask 异步投递（模拟真实传输的异步性）。任一端 close → 两端都触发 onClose。
 */
export function transportPair(): [Transport, Transport] {
  const make = () => ({ messages: new Emitter<RpcMessage>(), closes: new Emitter<string>(), closed: false })
  const a = make()
  const b = make()
  const closeBoth = (reason: string): void => {
    for (const side of [a, b]) {
      if (side.closed) continue
      side.closed = true
      side.closes.fire(reason)
    }
  }
  const endpoint = (self: typeof a, peer: typeof a): Transport => ({
    send(message) {
      if (self.closed) return
      const copy = JSON.parse(JSON.stringify(message)) as RpcMessage
      queueMicrotask(() => {
        if (!peer.closed) peer.messages.fire(copy)
      })
    },
    onMessage: (listener): Disposable => self.messages.event(listener),
    onClose: (listener): Disposable => self.closes.event(listener),
    close: (reason) => closeBoth(reason),
  })
  return [endpoint(a, b), endpoint(b, a)]
}
