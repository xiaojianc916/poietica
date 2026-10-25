import { isDecodeFailure, joinRelayParts } from './frame'
import type { RpcMessage } from './messages'
import { isRpcMessage } from './transport-core'

export const IPC_CHANNEL = 'poietica:rpc'
export const BRIDGE_GLOBAL = '__poieticaBridge'

/** UI 内核用的桥：收发的都是消息对象。生产环境由 {@link windowBridgeFromPreload} 包出来，测试直接注入假桥。 */
export interface WindowBridge {
  send(message: RpcMessage): void
  onMessage(listener: (message: RpcMessage) => void): () => void
  /** 拖放/粘贴的 File 对象 → 本地绝对路径（Electron 32+ 移除了 File.path，只能经 webUtils 获取） */
  pathForFile(file: object): string
}

/**
 * preload 通过 contextBridge 暴露给页面的唯一对象（线上形态）。
 * Host → UI 有两种消息：转交的 Core 消息拆成「信封对象 + 载荷 JSON 文本」两个参数 ——
 * 字符串跨 contextBridge 不拷贝（两个 world 同一个 V8 isolate），页面在自己的 world 里
 * JSON.parse（{@link joinRelayParts}），不再有整棵对象树的多层克隆；Host 自己发的消息
 * （core.status、终端输出……）仍是结构化克隆的对象，payloadJson 为 undefined。UI → Host 不变：消息对象。
 */
export interface PreloadBridge {
  send(message: RpcMessage): void
  onMessage(listener: (message: unknown, payloadJson?: string) => void): () => void
  pathForFile(file: object): string
}

/** 把 preload 的线上形态包成消息对象形态：转交的消息在这里解析载荷，坏消息交给 onBad 并丢弃 */
export function windowBridgeFromPreload(
  preload: PreloadBridge,
  onBad: (sample: string) => void = () => undefined,
): WindowBridge {
  return {
    send: (message) => preload.send(message),
    onMessage: (listener) =>
      preload.onMessage((message, payloadJson) => {
        if (typeof payloadJson !== 'string') {
          if (isRpcMessage(message)) listener(message)
          else onBad('[not jsonrpc] (object)')
          return
        }
        const joined = joinRelayParts(message, payloadJson)
        if (isDecodeFailure(joined)) onBad(`[${joined.failure}] ${payloadJson.slice(0, 200)}`)
        else listener(joined)
      }),
    pathForFile: (file) => preload.pathForFile(file),
  }
}
