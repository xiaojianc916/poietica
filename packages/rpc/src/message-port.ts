import type { Transport } from './transport'
import { isRpcMessage, TransportCore } from './transport-core'

/** 浏览器 MessagePort、Electron MessagePortMain 之外的任何“结构化克隆通道”只要满足这个接口即可 */
export interface MessagePortLike {
  postMessage(message: unknown): void
  addEventListener(type: 'message', listener: (event: { readonly data: unknown }) => void): void
  removeEventListener(type: 'message', listener: (event: { readonly data: unknown }) => void): void
  start?(): void
  close(): void
}

/**
 * MessagePort 没有可靠的“对端关闭”事件，所以只有本端调用 close() 才会触发 onClose。
 * 非 JSON-RPC 的消息（没有 jsonrpc: '2.0'）被忽略。
 */
export function createMessagePortTransport(port: MessagePortLike): Transport {
  const core = new TransportCore()
  const onMessage = (event: { readonly data: unknown }): void => {
    if (isRpcMessage(event.data)) core.deliver(event.data)
  }
  port.addEventListener('message', onMessage)
  port.start?.()
  return {
    send(message) {
      if (!core.closed) port.postMessage(message)
    },
    onMessage: (listener) => core.onMessage(listener),
    onClose: (listener) => core.onClose(listener),
    close(reason) {
      if (!core.markClosed(reason)) return
      port.removeEventListener('message', onMessage)
      port.close()
      core.dispose()
    },
  }
}
