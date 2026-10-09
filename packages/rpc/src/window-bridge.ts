import type { RpcMessage } from './messages'

export const IPC_CHANNEL = 'poietica:rpc'
export const BRIDGE_GLOBAL = '__poieticaBridge'

/** preload 通过 contextBridge 暴露给页面的唯一对象 */
export interface WindowBridge {
  send(message: RpcMessage): void
  onMessage(listener: (message: RpcMessage) => void): () => void
  /** 拖放/粘贴的 File 对象 → 本地绝对路径（Electron 32+ 移除了 File.path，只能经 webUtils 获取） */
  pathForFile(file: object): string
}
