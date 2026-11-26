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
  /** clearForeignFrames：omp 19 起被别的扩展的帧拒掉时允许清空再附着（Electron 无此场景，忽略这一格） */
  | { op: 'attach'; tabId: number; clearForeignFrames?: boolean }
  | { op: 'detach'; tabId: number }
  | {
      op: 'send'
      tabId: number
      sessionId?: string
      method: string
      params?: Record<string, unknown>
      clearForeignFrames?: boolean
    }
  /** active: false = 开在后台不抢焦点；不带则按 Chrome 的默认（选中）。 */
  | { op: 'createTab'; url: string; active?: boolean }
  | { op: 'removeTab'; tabId: number }
  | { op: 'activateTab'; tabId: number }
  | { op: 'group'; tabIds: number[]; title: string; color: string }
  | { op: 'ungroup'; tabIds: number[] }
  /**
   * omp 19 起把「下载到哪了」交给扩展找（Electron 的下载不在这条线上，扩展端没有 downloads API 时 omp 也不会发）。
   * 收进类型保证线上形状对齐；运行时不实现 —— relay-client 对认不出的 op 照样回 rpcResult。
   */
  | { op: 'findDownload'; guid: string }
  /**
   * 页内覆盖层（Chrome 侧面板 / 拾取那套 UI 用的）。Electron 内置浏览器画不了覆盖层，overlayProtocol 不在
   * hello 里声明，omp 不会发；收进类型保持对齐。
   */
  | { op: 'overlay'; tabId: number; action: 'mount' | 'unmount' | 'hide' | 'show' }

/*
 * `reload` 是 omp 18.14 起让扩展 `chrome.runtime.reload()` 的消息（扩展自更新）；我们的 hello 不带
 * `reloadProtocol`，omp 不会发它，relay-client 对非 `rpc` 消息本来就整体忽略。这里仍收进类型：
 * 线上形状要与 omp 对齐（见 browser-relay-conformance.ts）。
 * `input` / `callResult` 是 omp 19 的覆盖层与侧面板消息（OVERLAY_PROTOCOL / PANEL_PROTOCOL 没声明就不会
 * 来）；`pong` 已随心跳一起删掉 —— omp 19 的 RelayToExtMessage 里没有它。
 */
export type RelayInbound =
  | ({ t: 'rpc'; id: number } & RelayRpc)
  | { t: 'reload' }
  /** 覆盖层输入回执（CDP 输入已被 Chrome 确认后给覆盖层画）：fire-and-forget，不需要回 rpcResult */
  | { t: 'input'; tabId: number; input: RelayOverlayInput }
  /** 侧面板 `call` 的答复（我们不开侧面板，不会收到，类型上收下） */
  | { t: 'callResult'; id: number; ok: boolean; result?: unknown; error?: string }

/** 覆盖层输入的形状（omp 的 OverlayInput）：key 不带坐标，其余都要 x/y 主视口 CSS 像素 */
export type RelayOverlayInput =
  | { readonly kind: 'move' | 'release' | 'wheel'; readonly x: number; readonly y: number }
  | {
      readonly kind: 'press'
      readonly x: number
      readonly y: number
      readonly button: 'left' | 'middle' | 'right' | 'back' | 'forward' | 'none'
      readonly clickCount: number
    }
  | { readonly kind: 'key' }

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

/**
 * 心跳：我们这一侧定时发的 WebSocket 保活。omp 18 有 pong 应答、19 把整对 ping/pong 从协议里删了，
 * 它的 bridge 收到不认识的 `t` 直接忽略 —— 所以**不在** RelayOutbound（协议对齐检查只认 omp 收的形状），
 * relay-client 的 `post` 单独收这一格。
 */
export interface RelayKeepalive {
  readonly t: 'ping'
}
