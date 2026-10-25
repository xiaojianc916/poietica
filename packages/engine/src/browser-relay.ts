/*
 * 内置浏览器接进引擎的那条线（browser relay）：引擎跑 relay 服务，Host 的 browser 功能以
 * 「浏览器扩展」身份连 `ws://127.0.0.1:<port>/ext?token=<口令>`，把 Electron 的标签交给 agent 驾驶。
 * 端口由引擎挑（AgentEngine.browserRelay() 报出）；口令按数据根持久化在 DataLayout.relayTokenFile、
 * Host 直接读文件 —— 口令不过 RPC、也不进任何进程的环境变量（见 engine-omp 的 bootstrap/relay-token.ts）。
 * 线上形状对齐 omp 的 tools/browser/relay/protocol.ts（omp 内部契约、没有版本号），由 engine-omp 的
 * browser-relay-conformance.ts 在 typecheck 里验证漂移。
 * hello 必须带上 `discardedTabsProtocol`：bridge 拿它当能力闸门，不带时 probe 判成
 * outdated-extension、浏览器工具直接抛「扩展过期，请跑 omp browser-relay install」（实测）。
 */

/** 引擎的 relay 服务在哪儿（只有端口：口令走文件，见文件头） */
export interface BrowserRelayEndpoint {
  readonly port: number
}

const RELAY_TOKEN = /^[a-f0-9]{64}$/

/** 口令文件内容 → 口令（32 字节随机数的小写十六进制）；格式不对返回 null（生成方据此重建，读取方据此不连） */
export function parseRelayToken(text: string): string | null {
  const token = text.trim()
  return RELAY_TOKEN.test(token) ? token : null
}

export const DISCARDED_TABS_PROTOCOL_VERSION = 1

export interface TabSnapshot {
  tabId: number
  url: string
  title: string
  active: boolean
  /**
   * Chrome 把这张标签的内容卸了、激活时再装载。Electron 的 WebContentsView 没有这套省内存机制 ——
   * 标签一直活着，所以恒为 false；崩溃两次后转空白的那条路也仍是「空白标签」而不是「被丢弃」，
   * 照实报 false，不冒领一个会被 relay 当作「激活就会自己活过来」的状态。
   */
  discarded: boolean
  windowId: number
  pinned: boolean
  groupId: number
}

export type RelayRpc =
  | { op: 'attach'; tabId: number }
  | { op: 'detach'; tabId: number }
  | { op: 'send'; tabId: number; sessionId?: string; method: string; params?: Record<string, unknown> }
  /** active: false = 开在后台不抢焦点；不带则按 Chrome 的默认（选中）。 */
  | { op: 'createTab'; url: string; active?: boolean }
  | { op: 'removeTab'; tabId: number }
  | { op: 'activateTab'; tabId: number }
  | { op: 'group'; tabIds: number[]; title: string; color: string }
  | { op: 'ungroup'; tabIds: number[] }

export type RelayInbound = ({ t: 'rpc'; id: number } & RelayRpc) | { t: 'pong' }

export type RelayOutbound =
  | {
      t: 'hello'
      instanceId: string
      userAgent: string
      browserVersion: string
      tabs: TabSnapshot[]
      attachedTabIds: number[]
      /** 快照里带了 discarded 状态；缺了它这一侧的标签全被判成不 eligible（见文件头）。 */
      discardedTabsProtocol: number
    }
  | { t: 'rpcResult'; id: number; ok: true; result: unknown }
  | { t: 'rpcResult'; id: number; ok: false; error: string }
  /** params 与 omp 一致是可选的对象：CDP 事件的载荷总是对象（Electron 的 debugger 'message' 事件给的就是它） */
  | { t: 'cdpEvent'; tabId: number; sessionId?: string; method: string; params?: Record<string, unknown> }
  | { t: 'detached'; tabId: number; reason: string; relayInitiated: boolean }
  | { t: 'tabCreated'; tab: TabSnapshot }
  | { t: 'tabUpdated'; tab: TabSnapshot }
  | { t: 'tabRemoved'; tabId: number }
  | { t: 'ping' }
