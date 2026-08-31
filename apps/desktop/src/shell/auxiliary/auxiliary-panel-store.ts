import type { BrowserHostPort, BrowserState, BrowserViewportBounds } from '@poietica/browser'
import { createExternalStore } from '@poietica/external-store'
import { warn } from '@poietica/problem'

export type AuxiliaryLauncherKind = 'assistant' | 'review' | 'terminal' | 'browser'
export type AuxiliaryPaneKind = Exclude<AuxiliaryLauncherKind, 'browser'> | 'delegate'

export interface AuxiliaryPaneDescriptor {
  readonly kind: AuxiliaryLauncherKind
  readonly label: string
  readonly description: string
  readonly availability: 'ready' | 'planned'
}

export const AUXILIARY_LAUNCHER: readonly AuxiliaryPaneDescriptor[] = [
  {
    kind: 'assistant',
    label: '辅助对话',
    description: '',
    availability: 'planned',
  },
  {
    kind: 'review',
    label: '审查',
    description: '',
    availability: 'ready',
  },
  {
    kind: 'terminal',
    label: '终端',
    description: '',
    availability: 'planned',
  },
  {
    kind: 'browser',
    label: '浏览器',
    description: '',
    availability: 'ready',
  },
]

export interface AuxiliaryPane {
  readonly kind: AuxiliaryPaneKind
  readonly id: string
  readonly resourceId: string | null
}

/** 三个菜单的脸。同一时刻最多一个展开。 */
export type AuxiliaryMenuKind = 'new-tab' | 'tabs' | 'overflow'

export interface AuxiliaryPanelState {
  readonly host: BrowserState | null
  readonly panes: readonly AuxiliaryPane[]
  readonly activePaneId: string | null
  readonly openMenu: AuxiliaryMenuKind | null
}

export interface AuxiliaryPanelStore {
  readonly subscribe: (listen: () => void) => () => void
  readonly getSnapshot: () => AuxiliaryPanelState
  readonly start: () => () => void
  readonly setVisible: (visible: boolean) => void
  readonly reportViewport: (rect: BrowserViewportBounds) => void
  readonly openLauncherPane: (kind: AuxiliaryLauncherKind) => void
  readonly openDelegate: (agentId: string) => void
  readonly closePane: (id: string) => void
  readonly selectPane: (id: string | null) => void
  readonly setMenu: (kind: AuxiliaryMenuKind | null) => void
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
    readonly openExternally: (url: string) => void
  }
}

function failAlreadyStarted(): never {
  throw new Error('AuxiliaryPanelStore.start() called while already started')
}

export function createAuxiliaryPanelStore(port: BrowserHostPort): AuxiliaryPanelStore {
  let host: BrowserState | null = null
  let started = false
  let watchEpoch = 0
  let nativeVisible: boolean | null = null
  let panes: readonly AuxiliaryPane[] = []
  let activePaneId: string | null = null
  let openMenu: AuxiliaryMenuKind | null = null
  let snapshot: AuxiliaryPanelState = { host, panes, activePaneId, openMenu }

  function run(operation: string, task: () => Promise<void>): void {
    task().catch((cause: unknown) => {
      warn(`浏览器宿主没接上这次操作：${operation}`, { scope: 'auxiliary-panel', cause })
    })
  }

  const store = createExternalStore<AuxiliaryPanelState>({ read: () => snapshot })

  function publish(): void {
    snapshot = { host, panes, activePaneId, openMenu }
    store.notify()
  }

  function selectPane(id: string | null): void {
    if ((id !== null && !panes.some((pane) => pane.id === id)) || id === activePaneId) {
      return
    }
    activePaneId = id
    publish()
  }

  function openPane(pane: AuxiliaryPane): void {
    if (!panes.some((held) => held.id === pane.id)) {
      panes = [...panes, pane]
    }
    activePaneId = pane.id
    publish()
  }

  function setMenu(kind: AuxiliaryMenuKind | null): void {
    if (kind === openMenu) {
      return
    }

    openMenu = kind
    publish()
  }

  function openLauncherPane(kind: AuxiliaryLauncherKind): void {
    if (kind === 'browser') {
      selectPane(null)
      run('open-tab', () => port.openTab(null))
      return
    }

    openPane({ id: kind, kind, resourceId: null })
  }

  function openDelegate(agentId: string): void {
    openPane({ id: `delegate:${agentId}`, kind: 'delegate', resourceId: agentId })
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

    start: (): (() => void) => {
      if (started) {
        failAlreadyStarted()
      }

      started = true
      const epoch = ++watchEpoch
      let stopWatching: (() => void) | null = null

      void port
        .watch((state) => {
          if (epoch !== watchEpoch) {
            return
          }
          host = state
          publish()
        })
        .then(
          (stop) => {
            if (epoch !== watchEpoch) {
              stop()
              return
            }
            stopWatching = stop
          },
          (cause: unknown) => {
            if (epoch !== watchEpoch) {
              return
            }
            started = false
            warn('浏览器宿主的状态流没接上', { scope: 'auxiliary-panel', cause })
          },
        )

      return () => {
        if (epoch !== watchEpoch) {
          return
        }
        watchEpoch += 1
        started = false
        stopWatching?.()
        stopWatching = null
        if (nativeVisible === true) {
          nativeVisible = false
          run('hide-on-stop', () => port.setVisible(false))
        }
      }
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

    openLauncherPane,
    openDelegate,
    closePane,
    selectPane,
    setMenu,

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
      openExternally: (url) => run('open-externally', () => port.openExternally(url)),
    },
  }
}
