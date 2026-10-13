import type { ReactNode } from 'react'
import type { BrowserApi } from './api'
import type { BrowserPanelStore } from './store'
import { BrowserTabIcon } from './tab-strip'

/* 浏览器那一格交给右坞的**页签面**（panels 贡献的 dockTabs）。legacy 里浏览器标签与别的通道同处一条标签条，新架构里那一条归外壳，
 * 浏览器只把「这一格此刻有哪些标签」报上去 —— 真相住在浏览器宿主的 store 里，这里不做第二份副本。单列一个文件是为了能直接单测：
 * 只依赖 store 与 api，不碰 React，也不需要内核起来。 */
export function createBrowserDockTabs({
  api,
  report,
  store,
}: {
  readonly api: BrowserApi
  readonly report: (message: string, cause?: unknown) => void
  readonly store: BrowserPanelStore
}): {
  subscribe(listener: () => void): () => void
  tabs(): readonly { id: string; title: string; icon: ReactNode; active: boolean }[]
  onSelect(tabId: string): void
  onClose(tabId: string): void
  onOpen(): void
} {
  const run = (message: string, task: Promise<unknown>): void => {
    void task.catch((cause: unknown) => {
      report(message, cause)
    })
  }

  return {
    subscribe: (listener) => store.subscribe(listener),
    tabs: () => {
      const state = store.snapshot()

      if (state === null) {
        return []
      }

      return state.tabs.map((tab) => ({
        id: String(tab.id),
        title: tab.title,
        icon: <BrowserTabIcon tab={tab} />,
        active: tab.id === state.activeTabId,
      }))
    },
    onSelect: (tabId) => {
      run('标签页没能切换', api.selectTab(Number(tabId)))
    },
    onClose: (tabId) => {
      run('标签页没能关闭', api.closeTab(Number(tabId)))
    },
    onOpen: () => {
      run('新标签页没能打开', api.newTab(null))
    },
  }
}
