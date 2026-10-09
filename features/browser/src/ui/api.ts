import type { Disposable } from '@poietica/foundation'
import type { UiFeatureContext } from '@poietica/ui-kernel'
import { type BrowserState, browserContract, type PickedElement } from '../contract'

/**
 * `ctx.rpc(browserContract)` 的薄封装（07 页 §12E）。
 *
 * 契约以 tabId 寻址、方法面很窄；这里只换驼峰与「通知 → 订阅函数」两处口径，
 * 让面板组件不认识 RPC 的字符串名字。
 */
export function createBrowserApi(ctx: UiFeatureContext) {
  const rpc = ctx.rpc(browserContract)

  return {
    state: (): Promise<BrowserState> => rpc.call('browser.state', {}),
    newTab: (url: string | null): Promise<BrowserState> => rpc.call('browser.newTab', { url }),
    closeTab: (tabId: number): Promise<BrowserState> => rpc.call('browser.closeTab', { tabId }),
    selectTab: (tabId: number): Promise<BrowserState> => rpc.call('browser.selectTab', { tabId }),
    reopenClosed: (index: number): Promise<BrowserState> => rpc.call('browser.reopenClosed', { index }),
    navigate: (tabId: number, url: string): Promise<BrowserState> => rpc.call('browser.navigate', { tabId, url }),
    back: (tabId: number): Promise<Record<string, never>> => rpc.call('browser.back', { tabId }),
    forward: (tabId: number): Promise<Record<string, never>> => rpc.call('browser.forward', { tabId }),
    reload: (tabId: number): Promise<Record<string, never>> => rpc.call('browser.reload', { tabId }),
    stop: (tabId: number): Promise<Record<string, never>> => rpc.call('browser.stop', { tabId }),
    setZoom: (tabId: number, level: number): Promise<Record<string, never>> =>
      rpc.call('browser.setZoom', { tabId, level }),
    setBounds: (rect: { x: number; y: number; width: number; height: number }): Promise<Record<string, never>> =>
      rpc.call('browser.setBounds', rect),
    setVisible: (visible: boolean): Promise<Record<string, never>> => rpc.call('browser.setVisible', { visible }),
    pickElement: (tabId: number, theme: 'light' | 'dark'): Promise<Record<string, never>> =>
      rpc.call('browser.pickElement', { tabId, theme }),
    cancelPick: (): Promise<Record<string, never>> => rpc.call('browser.cancelPick', {}),
    onStateChanged: (listener: (state: BrowserState) => void): Disposable => rpc.on('browser.stateChanged', listener),
    onElementPicked: (listener: (picked: PickedElement) => void): Disposable =>
      rpc.on('browser.elementPicked', listener),
  }
}

export type BrowserApi = ReturnType<typeof createBrowserApi>
