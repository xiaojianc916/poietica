import { createExternalStore, warn } from '@poietica/core'

import type { BrowserHostPort, BrowserHostView, BrowserViewportRect } from './browser-port'

/**
 * 宿主快照在渲染层这一侧的唯一投影。
 *
 * 这里不拥有面板的开合与宽度 —— 那是外壳区域的几何，归 workspaceLayoutStore。
 * 本店只拥有：宿主广播的标签快照、原生可见性的去重下发、以及那组动作。
 */
export interface BrowserPanelState {
  readonly host: BrowserHostView | null
  /**
   * 面板内是否有浮层（标签列表、「更多操作」菜单）压在视口上。
   * 原生 webview 是独立窗口，永远盖过主窗口 HTML：浮层要见光，它必须让位。
   */
  readonly overlayOpen: boolean
}

export interface BrowserPanelStore {
  readonly subscribe: (listen: () => void) => () => void
  readonly getSnapshot: () => BrowserPanelState
  /** 幂等；订阅与进程同寿，所以不交回摘表函数。 */
  readonly start: () => void
  /** 原生 webview 该不该在屏幕上。合成在组合根，这里只去重下发。 */
  readonly setVisible: (visible: boolean) => void
  /** 浮层开合由浮层组件上报，与可见性的合成解耦。 */
  readonly setOverlayOpen: (open: boolean) => void
  readonly reportViewport: (rect: BrowserViewportRect) => void
  readonly actions: {
    readonly openTab: (url: string | null) => void
    readonly closeTab: (id: number) => void
    readonly selectTab: (id: number) => void
    readonly navigate: (id: number, address: string) => void
    readonly back: (id: number) => void
    readonly forward: (id: number) => void
    readonly reload: (id: number) => void
    readonly pickElement: (id: number) => void
    readonly reopenClosed: (index: number) => void
    readonly openDevtools: (id: number) => void
    readonly openExternal: (url: string) => void
  }
}

export function createBrowserPanelStore(port: BrowserHostPort): BrowserPanelStore {
  let host: BrowserHostView | null = null
  let overlayOpen = false
  let started = false
  let ensuredFirstTab = false
  let nativeVisible: boolean | null = null
  let snapshot: BrowserPanelState = { host, overlayOpen }

  /* 界面动作打不动宿主不是调用方要接的错误：记日志，界面靠快照自愈。 */
  function run(operation: string, task: () => Promise<void>): void {
    task().catch((cause: unknown) => {
      warn(`浏览器宿主没接上这次操作：${operation}`, { scope: 'browser-panel', cause })
    })
  }

  const store = createExternalStore<BrowserPanelState>({ read: () => snapshot })

  return {
    subscribe: store.subscribe,
    getSnapshot: () => snapshot,

    start: (): void => {
      if (started) {
        return
      }

      started = true

      void port
        .watch((state) => {
          host = state

          /*
           * 首次快照是空集时垫一个空白页：初始形态就是一个 about:blank 标签，
           * 而空白页在宿主侧没有内核实例，代价为零。
           */
          if (state.tabs.length === 0 && !ensuredFirstTab) {
            ensuredFirstTab = true
            run('open-first-tab', () => port.openTab(null))
          } else if (state.tabs.length > 0) {
            ensuredFirstTab = true
          }

          snapshot = { host, overlayOpen }
          store.notify()
        })
        .catch((cause: unknown) => {
          started = false
          warn('浏览器宿主的状态流没接上', { scope: 'browser-panel', cause })
        })
    },

    setVisible: (visible: boolean): void => {
      if (visible === nativeVisible) {
        return
      }

      nativeVisible = visible
      run('set-visible', () => port.setVisible(visible))
    },

    setOverlayOpen: (open: boolean): void => {
      if (open === overlayOpen) {
        return
      }

      overlayOpen = open
      snapshot = { host, overlayOpen }
      store.notify()
    },

    reportViewport: (rect: BrowserViewportRect): void => {
      run('set-bounds', () => port.setViewportBounds(rect))
    },

    actions: {
      openTab: (url) => {
        run('open-tab', () => port.openTab(url))
      },
      closeTab: (id) => {
        run('close-tab', () => port.closeTab(id))
      },
      selectTab: (id) => {
        run('select-tab', () => port.selectTab(id))
      },
      navigate: (id, address) => {
        run('navigate', () => port.navigate(id, address))
      },
      back: (id) => {
        run('back', () => port.back(id))
      },
      forward: (id) => {
        run('forward', () => port.forward(id))
      },
      reload: (id) => {
        run('reload', () => port.reload(id))
      },
      pickElement: (id) => {
        run('pick-element', () => port.pickElement(id))
      },
      reopenClosed: (index) => {
        run('reopen-closed', () => port.reopenClosed(index))
      },
      openDevtools: (id) => {
        run('open-devtools', () => port.openDevtools(id))
      },
      openExternal: (url) => {
        run('open-external', () => port.openExternal(url))
      },
    },
  }
}
