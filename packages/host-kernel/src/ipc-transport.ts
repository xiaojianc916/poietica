import type { Disposable } from '@poietica/foundation'
import { IPC_CHANNEL, type RpcMessage, type Transport } from '@poietica/rpc'
import { type IpcMainEvent, ipcMain, type WebContents } from 'electron'

function looksLikeRpc(value: unknown): value is RpcMessage {
  return typeof value === 'object' && value !== null && (value as { jsonrpc?: unknown }).jsonrpc === '2.0'
}

/** 一个 webContents 的一次“页面生命期”对应一个 Transport；页面重新加载时由 RpcHub 关闭旧的、创建新的。 */
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
      if (!closed && !wc.isDestroyed()) wc.send(IPC_CHANNEL, message)
    },
    onMessage: (l) => sub(messageListeners, l),
    onClose: (l) => sub(closeListeners, l),
    close,
  }
}
