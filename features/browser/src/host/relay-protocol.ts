/*
 * relay 的线上形状（07 页 §12D 的完整代码）。
 *
 * 正本是 omp 的 `tools/browser/relay/protocol.ts`（锚定 18.5.0）：那是它内部的契约，
 * 没有版本号，所以这里与它逐字对应，升级 omp 时一起核（16 页 §5 陷阱表）。
 */

export interface TabSnapshot {
  tabId: number
  url: string
  title: string
  active: boolean
  windowId: number
  pinned: boolean
  groupId: number
}

export type RelayRpc =
  | { op: 'attach'; tabId: number }
  | { op: 'detach'; tabId: number }
  | { op: 'send'; tabId: number; sessionId?: string; method: string; params?: Record<string, unknown> }
  | { op: 'createTab'; url: string }
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
    }
  | { t: 'rpcResult'; id: number; ok: true; result: unknown }
  | { t: 'rpcResult'; id: number; ok: false; error: string }
  | { t: 'cdpEvent'; tabId: number; sessionId?: string; method: string; params: unknown }
  | { t: 'detached'; tabId: number; reason: string; relayInitiated: boolean }
  | { t: 'tabCreated'; tab: TabSnapshot }
  | { t: 'tabUpdated'; tab: TabSnapshot }
  | { t: 'tabRemoved'; tabId: number }
  | { t: 'ping' }
