import { BRIDGE_GLOBAL, IPC_CHANNEL, type RpcMessage, type WindowBridge } from '@poietica/rpc'
import { contextBridge, ipcRenderer, webUtils } from 'electron'

const bridge: WindowBridge = {
  send: (message) => ipcRenderer.send(IPC_CHANNEL, message),
  onMessage: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, message: RpcMessage): void => listener(message)
    ipcRenderer.on(IPC_CHANNEL, handler)
    return () => {
      ipcRenderer.removeListener(IPC_CHANNEL, handler)
    }
  },
  pathForFile: (file) => webUtils.getPathForFile(file as File),
}
contextBridge.exposeInMainWorld(BRIDGE_GLOBAL, bridge)
