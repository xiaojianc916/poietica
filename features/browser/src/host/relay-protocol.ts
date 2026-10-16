/*
 * relay 的线上形状，对齐 omp 的 tools/browser/relay/protocol.ts：那是它内部的契约、没有版本号，
 * 升级 omp 时必须回来核对（AGENTS.md §11 点名要求核这一个文件）。
 *
 * **hello 必须带上 `discardedTabsProtocol`**：bridge 拿它当能力闸门
 * （`relay/bridge.ts` 的 `#eligible()`），对不上的实例每张标签都不 eligible ——
 * `Target.getTargets` 返回空、`/json/version` 报 `ompExtensionDiscardedTabsProtocol: "0"`，
 * 于是 `probe.ts` 判成 `outdated-extension`、浏览器工具直接抛「扩展过期，请跑 omp browser-relay install」。
 * 实测：不带这个字段时 `waitForRelayExtension` 返回 `outdated-extension`，带上才返回 `ready`。
 */

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
  | { t: 'cdpEvent'; tabId: number; sessionId?: string; method: string; params: unknown }
  | { t: 'detached'; tabId: number; reason: string; relayInitiated: boolean }
  | { t: 'tabCreated'; tab: TabSnapshot }
  | { t: 'tabUpdated'; tab: TabSnapshot }
  | { t: 'tabRemoved'; tabId: number }
  | { t: 'ping' }
