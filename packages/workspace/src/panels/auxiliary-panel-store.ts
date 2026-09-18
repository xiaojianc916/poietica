import type { BrowserHostPort, BrowserState, BrowserViewportBounds } from '@poietica/browser'
import { createExternalStore } from '@poietica/external-store'
import { warn } from '@poietica/problem'

export type AuxiliaryLauncherKind = 'assistant' | 'review' | 'terminal' | 'browser'
/*
 * delegate 与 file 不进 catalog 的 launcher：前者只响应主时间线的工具调用，后者只由
 * 点开一份文档的人开出来。catalog 是「这里能开什么」的清单，不是全部通道种类的清单。
 */
export type AuxiliaryPaneKind = Exclude<AuxiliaryLauncherKind, 'browser'> | 'delegate' | 'file'

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
    availability: 'ready',
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

/**
 * 面板此刻在看谁。一格通道与浏览器是同一条选择的两个取值：'browser' 只表示选择落在
 * 宿主标签那一段上，不表示那一段有标签。
 */
export type AuxiliaryFocus =
  | { readonly kind: 'pane'; readonly id: string }
  | { readonly kind: 'browser' }

export interface AuxiliaryPanelState {
  readonly host: BrowserState | null
  readonly panes: readonly AuxiliaryPane[]
  readonly focus: AuxiliaryFocus
  readonly openMenu: AuxiliaryMenuKind | null
}

/**
 * 一格里装的东西，按归属分账。
 *
 * 归属是一个键：对话用它的 threadId，设置页用只有它自己用的那个键。别处的标签页不跟过来，
 * 本格的标签页也不会留在别处 —— 与「哪条对话的右栏是开的」同一条道理，两处状态互不串门。
 */
interface OwnedPanel {
  readonly panes: readonly AuxiliaryPane[]
  readonly focus: AuxiliaryFocus
  readonly openMenu: AuxiliaryMenuKind | null
}

const EMPTY_PANEL: OwnedPanel = Object.freeze({
  panes: [] as readonly AuxiliaryPane[],
  focus: { kind: 'browser' } as AuxiliaryFocus,
  openMenu: null,
})

export interface AuxiliaryPanelStore {
  readonly subscribe: (listen: () => void) => () => void
  readonly getSnapshot: () => AuxiliaryPanelState
  readonly start: () => () => void
  readonly setVisible: (visible: boolean) => void
  /**
   * 这一格此刻归谁。换归属就是换整格内容，快照跟着换。
   *
   * ownsBrowser 说的是浏览器那一段算不算这一格的。浏览器在宿主里只有一份（一个窗口一个
   * 子 webview），不是每格一份：不认领它的格子，别处打开的标签页不会跟进来，也不会有
   * 一格「选中浏览器」把别处的页面拽到眼前。由停靠方声明，与 setVisible 同一个位置。
   */
  readonly setOwner: (owner: string | null, ownsBrowser: boolean) => void
  readonly reportViewport: (rect: BrowserViewportBounds) => void
  readonly openLauncherPane: (kind: AuxiliaryLauncherKind) => void
  /**
   * 开一格委派通道。
   *
   * 收归属而不是往「当前那一格」里塞：调用它的人刚刚才把这一格认领给某条对话，
   * 而认领要等下一次渲染才传到面板上，靠当前归属会落进上一条对话的格子里。
   */
  readonly openDelegate: (owner: string, agentId: string) => void
  /**
   * 开一份文档。resourceId 是不透明的：本包只认它是一格的标识，内容由宿主的渲染器解读。
   * 同一份文档第二次打开是聚焦，不是第二个标签。归属同上一条。
   */
  readonly openFile: (owner: string, resourceId: string) => void
  /** 关掉本格里的所有文档格。设置里这一格只有文档，收起右栏就是关掉它们。 */
  readonly closeFilePanes: () => void
  readonly closePane: (id: string) => void
  readonly selectPane: (id: string) => void
  readonly selectBrowser: () => void
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
  /* 每一格的归属键与内容。没有归属，就没有可投影的一格。 */
  const panels = new Map<string, OwnedPanel>()
  let owner: string | null = null
  /* 当前这一格认不认领浏览器那一段。 */
  let ownsBrowser = true
  let snapshot: AuxiliaryPanelState = { host, ...EMPTY_PANEL }

  function run(operation: string, task: () => Promise<void>): void {
    task().catch((cause: unknown) => {
      warn(`浏览器宿主没接上这次操作：${operation}`, { scope: 'auxiliary-panel', cause })
    })
  }

  const store = createExternalStore<AuxiliaryPanelState>({ read: () => snapshot })

  /* 本格此刻装着什么。归属缺席时是一格空面板，不是别处那一格。 */
  function held(): OwnedPanel {
    return owner === null ? EMPTY_PANEL : (panels.get(owner) ?? EMPTY_PANEL)
  }

  /* 写回本格再投影。归属缺席时无处可写。 */
  function keep(next: OwnedPanel): void {
    if (owner === null) {
      return
    }

    panels.set(owner, next)
    publish()
  }

  /*
   * 每次发布都把焦点落到实处：指向的通道被关掉、或宿主一格标签都不剩时，焦点顺着
   * 标签条移到还在的那一段。整格空了才回到启动器 —— 关掉一格不该让另一格消失。
   */
  function resolved(current: OwnedPanel, browser: BrowserState | null): AuxiliaryFocus {
    if (current.focus.kind === 'pane') {
      const currentId = current.focus.id
      if (current.panes.some((pane) => pane.id === currentId)) {
        return current.focus
      }
    }

    if (current.focus.kind === 'browser' && (browser?.tabs.length ?? 0) > 0) {
      return current.focus
    }

    const last = current.panes.at(-1)

    return last === undefined ? { kind: 'browser' } : { kind: 'pane', id: last.id }
  }

  function publish(): void {
    const current = held()
    /* 不认领浏览器的格子里，宿主那一段整个不在：标签页、地址栏、子 webview 都不投影。 */
    const browser = ownsBrowser ? host : null
    const focus = resolved(current, browser)
    const settled = focus === current.focus ? current : { ...current, focus }

    if (settled !== current && owner !== null) {
      panels.set(owner, settled)
    }

    snapshot = {
      host: browser,
      panes: settled.panes,
      focus: settled.focus,
      openMenu: settled.openMenu,
    }
    store.notify()
  }

  function selectPane(id: string): void {
    const current = held()

    if (current.focus.kind === 'pane' && current.focus.id === id) {
      return
    }
    if (!current.panes.some((pane) => pane.id === id)) {
      return
    }

    keep({ ...current, focus: { kind: 'pane', id } })
  }

  function selectBrowser(): void {
    const current = held()

    /* 没有浏览器那一段的格子里，「选中浏览器」这件事不存在。 */
    if (!ownsBrowser || current.focus.kind === 'browser') {
      return
    }

    keep({ ...current, focus: { kind: 'browser' } })
  }

  function openPane(pane: AuxiliaryPane): void {
    if (owner === null) {
      return
    }

    write(owner, pane)
  }

  /* 往指定归属里开一格：归属不是当前这一格时只记账，不投影。 */
  function write(target: string, pane: AuxiliaryPane): void {
    const current = panels.get(target) ?? EMPTY_PANEL
    const panes = current.panes.some((open) => open.id === pane.id)
      ? current.panes
      : [...current.panes, pane]

    panels.set(target, { ...current, panes, focus: { kind: 'pane', id: pane.id } })

    if (target === owner) {
      publish()
    }
  }

  function setMenu(kind: AuxiliaryMenuKind | null): void {
    const current = held()

    if (kind === current.openMenu) {
      return
    }

    keep({ ...current, openMenu: kind })
  }

  function openLauncherPane(kind: AuxiliaryLauncherKind): void {
    if (kind === 'browser') {
      selectBrowser()
      run('open-tab', () => port.openTab(null))
      return
    }

    openPane({ id: kind, kind, resourceId: null })
  }

  function openDelegate(target: string, agentId: string): void {
    write(target, { id: `delegate:${agentId}`, kind: 'delegate', resourceId: agentId })
  }

  function openFile(target: string, resourceId: string): void {
    write(target, { id: `file:${resourceId}`, kind: 'file', resourceId })
  }

  function closeFilePanes(): void {
    const current = held()
    const kept = current.panes.filter((pane) => pane.kind !== 'file')

    if (kept.length === current.panes.length) {
      return
    }

    keep({ ...current, panes: kept })
  }

  function closePane(id: string): void {
    const current = held()

    if (!current.panes.some((pane) => pane.id === id)) {
      return
    }

    keep({ ...current, panes: current.panes.filter((open) => open.id !== id) })
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

    setOwner: (next, browser): void => {
      if (next === owner && browser === ownsBrowser) {
        return
      }

      owner = next
      ownsBrowser = browser
      publish()
    },

    reportViewport: (rect): void => {
      run('set-bounds', () => port.setViewportBounds(rect))
    },

    openLauncherPane,
    openDelegate,
    openFile,
    closeFilePanes,
    closePane,
    selectPane,
    selectBrowser,
    setMenu,

    actions: {
      openTab: (url) => {
        selectBrowser()
        run('open-tab', () => port.openTab(url))
      },
      closeTab: (id) => run('close-tab', () => port.closeTab(id)),
      selectTab: (id) => {
        selectBrowser()
        run('select-tab', () => port.selectTab(id))
      },
      navigate: (id, address) => run('navigate', () => port.navigate(id, address)),
      back: (id) => run('back', () => port.back(id)),
      forward: (id) => run('forward', () => port.forward(id)),
      reload: (id) => run('reload', () => port.reload(id)),
      print: (id) => run('print', () => port.print(id)),
      setElementPicker: (id, enabled) =>
        run('set-element-picker', () =>
          port.setElementPicker(
            id,
            enabled,
            document.documentElement.dataset['theme'] === 'dark' ? 'dark' : 'light',
          ),
        ),
      reopenClosed: (index) => run('reopen-closed', () => port.reopenClosed(index)),
      openExternally: (url) => run('open-externally', () => port.openExternally(url)),
    },
  }
}
