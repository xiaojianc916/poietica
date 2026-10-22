import { BRIDGE_GLOBAL, IPC_CHANNEL, type PreloadBridge } from '@poietica/rpc'
import { contextBridge, ipcRenderer, webUtils } from 'electron'

/*
 * Host 转交的 Core 消息是「信封对象 + 载荷 JSON 文本」两个参数：原样交给页面 —— 字符串跨 contextBridge 不拷贝
 * （两个 world 同一个 V8 isolate），页面在自己的 world 里 JSON.parse。Host 自己的消息只有一个对象参数。
 */
const bridge: PreloadBridge = {
  send: (message) => ipcRenderer.send(IPC_CHANNEL, message),
  onMessage: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, message: unknown, payloadJson?: unknown): void =>
      listener(message, typeof payloadJson === 'string' ? payloadJson : undefined)
    ipcRenderer.on(IPC_CHANNEL, handler)
    return () => {
      ipcRenderer.removeListener(IPC_CHANNEL, handler)
    }
  },
  pathForFile: (file) => webUtils.getPathForFile(file as File),
}
contextBridge.exposeInMainWorld(BRIDGE_GLOBAL, bridge)
