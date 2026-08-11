import { createExternalStore, createPreference, warn } from '@poietica/core'
import * as v from 'valibot'

import type { BrowserHostPort, BrowserHostView, BrowserViewportRect } from './browser-port'

/** 面板几何的边界，唯一声明处：组件与状态店都从这里读。 */
export const BROWSER_PANEL = {
  minWidth: 320,
  maxWidth: 800,
  defaultWidth: 420,
} as const

/**
 * 浏览器面板状态的唯一所有者（渲染层这一侧）。
 *
 * 开合与宽度是跨会话保留的用户意图，走 createPreference 那一条管线；
 * isResizing 是单次拖拽内的瞬时状态；host 是宿主广播来的快照 —— 三者
 * 都在这里，组件本地不许再记一份。
 */
export interface BrowserPanelState {
  readonly open: boolean
  readonly width: number
  readonly isResizing: boolean
  readonly host: BrowserHostView | null
}

interface PanelIntent {
  readonly open: boolean
  readonly width: number
}

const DEFAULT_INTENT: PanelIntent = { open: false, width: BROWSER_PANEL.defaultWidth }

function clampWidth(width: number): number {
  return Math.min(BROWSER_PANEL.maxWidth, Math.max(BROWSER_PANEL.minWidth, Math.round(width)))
}

/* 持久化形状由 schema 声明，逐字段兜底交给 valibot，与工作区布局同款。 */
const PersistedPanelSchema = v.object({
  open: v.fallback(v.boolean(), DEFAULT_INTENT.open),
  width: v.fallback(v.pipe(v.number(), v.finite(), v.transform(clampWidth)), DEFAULT_INTENT.width),
})

const FAILURE = {
  read: '读不出浏览器面板偏好，回到默认布局',
  write: '写不进浏览器面板偏好，下次启动回到默认布局',
}

export interface BrowserPanelStore {
  readonly subscribe: (listen: () => void) => () => void
  readonly getSnapshot: () => BrowserPanelState
  /** 幂等；订阅与进程同寿，所以不交回摘表函数。 */
  readonly start: () => void
  /** 屏幕上是不是对话表面。原生可见性 = open 且 surfaceActive，只在这里合成。 */
  readonly setSurfaceActive: (active: boolean) => void
  readonly togglePanel: () => void
  readonly setPanelWidth: (width: number) => void
  readonly setResizing: (resizing: boolean) => void
  readonly reportViewport: (rect: BrowserViewportRect) => void
  readonly actions: {
    readonly openTab: (url: string | null) => void
    readonly closeTab: (id: number) => void
    readonly selectTab: (id: number) => void
    readonly navigate: (id: number, address: string) => void
    readonly back: (id: number) => void
    readonly forward: (id: number) => void
    readonly reload: (id: number) => void
    readonly reopenClosed: (index: number) => void
    readonly openDevtools: (id: number) => void
    readonly openExternal: (url: string) => void
  }
}

export function createBrowserPanelStore(port: BrowserHostPort): BrowserPanelStore {
  const persisted = createPreference<PanelIntent>({
    key: 'poietica.browser.panel.v1',
    fallback: DEFAULT_INTENT,
    decode: (raw) => v.parse(PersistedPanelSchema, JSON.parse(raw)),
    encode: (value) => JSON.stringify(value),
    onFailure: ({ stage, cause }) => {
      warn(FAILURE[stage], { scope: 'browser-panel', cause })
    },
  })

  let intent = persisted.read()
  let resizing = false
  let host: BrowserHostView | null = null
  let surfaceActive = false
  let started = false
  let ensuredFirstTab = false
  let nativeVisible: boolean | null = null
  let snapshot: BrowserPanelState = { ...intent, isResizing: false, host }

  /* 界面动作打不动宿主不是调用方要接的错误：记日志，界面靠快照自愈。 */
  function run(operation: string, task: () => Promise<void>): void {
    task().catch((cause: unknown) => {
      warn(`浏览器宿主没接上这次操作：${operation}`, { scope: 'browser-panel', cause })
    })
  }

  function publish(): void {
    const next: BrowserPanelState = { ...intent, isResizing: resizing, host }

    if (
      next.open === snapshot.open &&
      next.width === snapshot.width &&
      next.isResizing === snapshot.isResizing &&
      next.host === snapshot.host
    ) {
      return
    }

    snapshot = next
    store.notify()
  }

  /* 另一个窗口改了同一份偏好：意图以那一侧为准。 */
  function adopt(): void {
    intent = persisted.read()
    publish()
    syncNativeVisibility()
  }

  const store = createExternalStore<BrowserPanelState>({
    read: () => snapshot,
    activate: () => persisted.subscribe(adopt),
  })

  /*
   * 原生 webview 的可见性只有这一个写点。开合、切表面、跨窗口跟随都汇到
   * 这里比较一次再发 —— 两处各自发 setVisible 就是两份真相。
   */
  function syncNativeVisibility(): void {
    const visible = intent.open && surfaceActive

    if (visible === nativeVisible) {
      return
    }

    nativeVisible = visible
    run('set-visible', () => port.setVisible(visible))
  }

  function settle(next: PanelIntent): void {
    if (next.open === intent.open && next.width === intent.width) {
      return
    }

    intent = next
    publish()

    if (!resizing) {
      persisted.write(next)
    }

    syncNativeVisibility()
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
        .watch((state) => {
          host = state

          /*
           * 首次快照是空集时垫一个空白页：图一的初始形态就是一个
           * about:blank 标签，而空白页在宿主侧没有内核实例，代价为零。
           */
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

    setSurfaceActive: (active: boolean): void => {
      if (active === surfaceActive) {
        return
      }

      surfaceActive = active
      syncNativeVisibility()
    },

    togglePanel: (): void => {
      settle({ ...intent, open: !intent.open })
    },

    setPanelWidth: (width: number): void => {
      settle({ ...intent, width: clampWidth(width) })
    },

    setResizing: (value: boolean): void => {
      if (value === resizing) {
        return
      }

      resizing = value
      publish()

      /* 松手那一刻，把拖拽期间累积的宽度一次落盘。 */
      if (!value) {
        persisted.write(intent)
      }
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
