import { createExternalStore, warn } from '@poietica/core'

import type {
  BrowserHostPort,
  BrowserPopupRequest,
  BrowserState,
  BrowserViewportBounds,
} from './browser-port'

/** 一格通道：kind 由宿主定义并据此查渲染器，id 在 dock 内唯一。 */
export interface DockPane {
  readonly kind: string
  readonly id: string
}

export interface BrowserPanelState {
  readonly host: BrowserState | null
  readonly panes: readonly DockPane[]
  readonly activePaneId: string | null
}

export interface BrowserPanelStore {
  readonly subscribe: (listen: () => void) => () => void
  readonly getSnapshot: () => BrowserPanelState
  readonly start: () => void
  readonly setVisible: (visible: boolean) => void
  readonly reportViewport: (rect: BrowserViewportBounds) => void
  readonly openPane: (pane: DockPane) => void
  readonly closePane: (id: string) => void
  readonly selectPane: (id: string | null) => void
  readonly actions: {
    readonly openTab: (url: string | null) => void
    readonly closeTab: (id: number) => void
    readonly selectTab: (id: number) => void
    readonly navigate: (id: number, address: string) => void
    readonly back: (id: number) => void
    readonly forward: (id: number) => void
    readonly reload: (id: number) => void
    readonly print: (id: number) => void
    readonly setElementPicker: (id: number, enabled: boolean) => void
    readonly reopenClosed: (index: number) => void
    readonly openPopup: (request: BrowserPopupRequest, rect: BrowserViewportBounds) => void
    readonly closePopup: () => void
  }
}

export function createBrowserPanelStore(port: BrowserHostPort): BrowserPanelStore {
  let host: BrowserState | null = null
  let started = false
  let ensuredFirstTab = false
  let nativeVisible: boolean | null = null
  let panes: readonly DockPane[] = []
  let activePaneId: string | null = null
  let snapshot: BrowserPanelState = { host, panes, activePaneId }

  function run(operation: string, task: () => Promise<void>): void {
    task().catch((cause: unknown) => {
      warn(`浏览器宿主没接上这次操作：${operation}`, { scope: 'browser-panel', cause })
    })
  }

  const store = createExternalStore<BrowserPanelState>({ read: () => snapshot })

  function publish(): void {
    snapshot = { host, panes, activePaneId }
    store.notify()
  }

  function selectPane(id: string | null): void {
    if ((id !== null && !panes.some((pane) => pane.id === id)) || id === activePaneId) {
      return
    }
    activePaneId = id
    publish()
  }

  function openPane(pane: DockPane): void {
    if (!panes.some((held) => held.id === pane.id)) {
      panes = [...panes, pane]
    }
    activePaneId = pane.id
    publish()
  }

  function closePane(id: string): void {
    if (!panes.some((pane) => pane.id === id)) {
      return
    }
    panes = panes.filter((open) => open.id !== id)
    activePaneId = activePaneId === id ? (panes.at(-1)?.id ?? null) : activePaneId
    publish()
  }

  return {
    subscribe: store.subscribe,
    getSnapshot: () => snapshot,

    start: (): void => {
      if (started) {
        return
      }
      started = true

      void port
        .watchPopupActions((action) => {
          if (action.action === 'select-pane' && action.paneId !== null) {
            selectPane(action.paneId)
          } else if (action.action === 'close-pane' && action.paneId !== null) {
            closePane(action.paneId)
          } else if (action.action === 'select-tab' && action.tabId !== null) {
            const tabId = action.tabId
            selectPane(null)
            run('select-tab', () => port.selectTab(tabId))
          } else if (action.action === 'close-tab' && action.tabId !== null) {
            const tabId = action.tabId
            run('close-tab', () => port.closeTab(tabId))
          } else if (action.action === 'reopen-closed' && action.index !== null) {
            const index = action.index
            selectPane(null)
            run('reopen-closed', () => port.reopenClosed(index))
          } else if (action.action === 'open-tab') {
            selectPane(null)
            run('open-tab', () => port.openTab(null))
          } else if (action.action === 'open-pane' && action.paneKind !== null) {
            /* 菜单开出来的通道一种一格：id 就是 kind，再点一次回到同一格。 */
            openPane({ id: action.paneKind, kind: action.paneKind })
          }
        })
        .catch((cause: unknown) => {
          warn('浏览器浮层动作流没接上', { scope: 'browser-panel', cause })
        })

      void port
        .watch((state) => {
          host = state

          if (state.tabs.length === 0 && !ensuredFirstTab) {
            ensuredFirstTab = true
            run('open-first-tab', () => port.openTab(null))
          } else if (state.tabs.length > 0) {
            ensuredFirstTab = true
          }

          publish()
        })
        .catch((cause: unknown) => {
          started = false
          warn('浏览器宿主的状态流没接上', { scope: 'browser-panel', cause })
        })
    },

    setVisible: (visible): void => {
      if (visible === nativeVisible) {
        return
      }
      nativeVisible = visible
      run('set-visible', () => port.setVisible(visible))
    },

    reportViewport: (rect): void => {
      run('set-bounds', () => port.setViewportBounds(rect))
    },

    openPane,
    closePane,
    selectPane,

    actions: {
      openTab: (url) => {
        selectPane(null)
        run('open-tab', () => port.openTab(url))
      },
      closeTab: (id) => run('close-tab', () => port.closeTab(id)),
      selectTab: (id) => {
        selectPane(null)
        run('select-tab', () => port.selectTab(id))
      },
      navigate: (id, address) => run('navigate', () => port.navigate(id, address)),
      back: (id) => run('back', () => port.back(id)),
      forward: (id) => run('forward', () => port.forward(id)),
      reload: (id) => run('reload', () => port.reload(id)),
      print: (id) => run('print', () => port.print(id)),
      setElementPicker: (id, enabled) =>
        run('set-element-picker', () => port.setElementPicker(id, enabled)),
      reopenClosed: (index) => run('reopen-closed', () => port.reopenClosed(index)),
      openPopup: (request, rect) => run('open-popup', () => port.openPopup(request, rect)),
      closePopup: () => run('close-popup', () => port.closePopup()),
    },
  }
}
