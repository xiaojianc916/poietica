import type { Disposable } from '@poietica/foundation'
import { IPC_CHANNEL, type RpcMessage, relayParts, type Transport } from '@poietica/rpc'
import { type IpcMainEvent, ipcMain, type WebContents } from 'electron'

function looksLikeRpc(value: unknown): value is RpcMessage {
  return typeof value === 'object' && value !== null && (value as { jsonrpc?: unknown }).jsonrpc === '2.0'
}

/**
 * 一个 webContents 的一次“页面生命期”对应一个 Transport；页面重新加载时由 RpcHub 关闭旧的、创建新的。
 *
 * 发往页面：载荷是 RawJson 的消息（转交的 Core 回复与通知）发成「信封对象 + 载荷 JSON 文本」两个参数 ——
 * 主线程上只有一次 UTF-8 解码（simdutf）与字符串的 memcpy，不 JSON.parse、不克隆对象树；Host 自己的消息仍按
 * 对象结构化克隆。页面一侧见 rpc 的 PreloadBridge / windowBridgeFromPreload。
 */
export function createIpcTransport(wc: WebContents): Transport {
  const messageListeners = new Set<(m: RpcMessage) => void>()
  const closeListeners = new Set<(reason: string) => void>()
  let closed = false
  const onIpc = (event: IpcMainEvent, message: unknown): void => {
    if (closed || event.sender !== wc || !looksLikeRpc(message)) return
    for (const l of [...messageListeners]) l(message)
  }
  const onDestroyed = (): void => close('webContents destroyed')
  ipcMain.on(IPC_CHANNEL, onIpc)
  wc.once('destroyed', onDestroyed)
  function close(reason: string): void {
    if (closed) return
    closed = true
    ipcMain.removeListener(IPC_CHANNEL, onIpc)
    wc.removeListener('destroyed', onDestroyed)
    for (const l of [...closeListeners]) l(reason)
  }
  const sub = <T>(set: Set<T>, l: T): Disposable => {
    set.add(l)
    return {
      dispose: () => {
        set.delete(l)
      },
    }
  }
  return {
    send(message) {
      if (closed || wc.isDestroyed()) return
      const relay = relayParts(message)
      if (relay === null) wc.send(IPC_CHANNEL, message)
      else wc.send(IPC_CHANNEL, relay[0], relay[1])
    },
    onMessage: (l) => sub(messageListeners, l),
    onClose: (l) => sub(closeListeners, l),
    close,
  }
}
