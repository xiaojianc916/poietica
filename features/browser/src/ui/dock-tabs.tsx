import type { ReactNode } from 'react'
import type { BrowserApi } from './api'
import type { BrowserPanelStore } from './store'
import { BrowserTabIcon } from './tab-strip'

/*
 * 浏览器那一格交给右坞的**页签面**（`panels` 贡献的 `dockTabs`）。
 *
 * legacy 的浏览器标签与别的通道同处一条标签条（auxiliary-tab-strip.tsx 把
 * `host.tabs` 与 `panes` 一起摊进同一个 tablist），新架构里那一条标签条归外壳
 * （packages/workbench/src/parts/auxiliary-dock.tsx），浏览器只把「这一格此刻有哪些
 * 标签」报上去 —— 真相仍住在浏览器宿主的 store 里，这里不做第二份副本。
 *
 * 单列一个文件是为了能直接单测：它只依赖 store 与 api 两个对象，不碰 React，也不需要
 * 内核起来（`ui/index.tsx` 的 setup 里只是把它挂到贡献上）。
 */
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
    /* 标签号在契约里是数，坞只认字符串（页签 id 是 DOM 的键），转换收在这里一处。 */
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
