import type { SplitterActivity } from '@poietica/design-system'
import { createExternalStore, type Preference } from '@poietica/external-store'
import { auxiliaryMaxWidth, type SidebarDock, WORKSPACE_LAYOUT } from '@poietica/workspace'

export type { SplitterActivity }
export type SplitterRegion = 'sidebar' | 'auxiliary'
export interface LayoutIntent {
  readonly sidebarOpen: boolean
  readonly sidebarWidth: number
  readonly auxiliaryThread: string | null
  readonly auxiliaryWidth: number
}
export interface WorkspaceLayoutState extends LayoutIntent {
  readonly todoThread: string | null
  readonly splitter: SplitterActivity
  readonly splitterRegion: SplitterRegion
  /** 辅助面板铺满主区+右栏的瞬时态；不落盘，收起面板即失效（外壳据此判定）。 */
  readonly auxiliaryFullscreen: boolean
}
export const DEFAULT_LAYOUT_INTENT: LayoutIntent = Object.freeze({
  sidebarOpen: true,
  sidebarWidth: WORKSPACE_LAYOUT.sidebar.defaultWidth,
  auxiliaryThread: null,
  auxiliaryWidth: WORKSPACE_LAYOUT.auxiliary.defaultWidth,
})
function clampWidth(value: number, bounds: { minWidth: number; maxWidth: number }): number {
  if (!Number.isFinite(value)) {
    throw new RangeError('Pane width must be finite.')
  }
  return Math.min(bounds.maxWidth, Math.max(bounds.minWidth, Math.round(value)))
}
export const clampSidebarWidth = (value: number): number =>
  clampWidth(value, WORKSPACE_LAYOUT.sidebar)

/*
 * 辅助列的上限是侧边栏状态的因变量（见 auxiliaryMaxWidth），所以钳制要连侧边栏
 * 一起看 —— 拖拽值与落盘值走的是同一个上限。
 */
const clampAuxiliaryWidth = (value: number, sidebar: SidebarDock): number =>
  clampWidth(value, {
    minWidth: WORKSPACE_LAYOUT.auxiliary.minWidth,
    maxWidth: auxiliaryMaxWidth(sidebar),
  })

/* 侧边栏一变，辅助列就得重新落回它当时的上限之内 —— 一份意图只在一个地方钳制。 */
function normalize(intent: LayoutIntent): LayoutIntent {
  const auxiliaryWidth = clampAuxiliaryWidth(intent.auxiliaryWidth, intent)
  return auxiliaryWidth === intent.auxiliaryWidth ? intent : { ...intent, auxiliaryWidth }
}

function intentOf(state: LayoutIntent): LayoutIntent {
  return {
    sidebarOpen: state.sidebarOpen,
    sidebarWidth: state.sidebarWidth,
    auxiliaryThread: state.auxiliaryThread,
    auxiliaryWidth: state.auxiliaryWidth,
  }
}
function sameIntent(left: LayoutIntent, right: LayoutIntent): boolean {
  return (
    left.sidebarOpen === right.sidebarOpen &&
    left.sidebarWidth === right.sidebarWidth &&
    left.auxiliaryThread === right.auxiliaryThread &&
    left.auxiliaryWidth === right.auxiliaryWidth
  )
}

export type WorkspaceLayoutStore = ReturnType<typeof createWorkspaceLayoutStore>

export function createWorkspaceLayoutStore(persisted: Preference<LayoutIntent>) {
  let disposed = false
  let detachPersistence: (() => void) | undefined
  let snapshot: WorkspaceLayoutState = Object.freeze({
    ...normalize(persisted.read()),
    todoThread: null,
    splitter: 'idle',
    splitterRegion: 'sidebar',
    auxiliaryFullscreen: false,
  })
  const store = createExternalStore({
    read: () => snapshot,
    activate: () => {
      if (disposed) {
        return undefined
      }
      const stop = persisted.subscribe(() => {
        commit(normalize(persisted.read()))
      })
      detachPersistence = stop
      return () => {
        if (detachPersistence === stop) {
          detachPersistence = undefined
        }
        stop()
      }
    },
  })
  function commit(patch: Partial<WorkspaceLayoutState>): boolean {
    if (disposed) {
      return false
    }
    const next = { ...snapshot, ...patch }
    if (
      sameIntent(snapshot, next) &&
      snapshot.todoThread === next.todoThread &&
      snapshot.splitter === next.splitter &&
      snapshot.splitterRegion === next.splitterRegion &&
      snapshot.auxiliaryFullscreen === next.auxiliaryFullscreen
    ) {
      return false
    }
    snapshot = Object.freeze(next)
    store.notify()
    return true
  }
  function flush(): void {
    const intent = intentOf(snapshot)
    if (!sameIntent(intent, persisted.read())) {
      persisted.write(intent)
    }
  }
  function settle(patch: Partial<WorkspaceLayoutState>): void {
    if (commit(patch) && snapshot.splitter !== 'drag') {
      flush()
    }
  }
  function activity(region: SplitterRegion, next: SplitterActivity): void {
    if (snapshot.splitter === 'drag' && region !== snapshot.splitterRegion) {
      return
    }
    const wasDragging = snapshot.splitter === 'drag'
    if (commit({ splitter: next, splitterRegion: region }) && wasDragging && next !== 'drag') {
      flush()
    }
  }
  return {
    subscribe: store.subscribe,
    getSnapshot: store.read,
    setSidebarOpen: (open: boolean): void => {
      settle(normalize({ ...intentOf(snapshot), sidebarOpen: open }))
    },
    toggleSidebar: (): void => {
      settle(normalize({ ...intentOf(snapshot), sidebarOpen: !snapshot.sidebarOpen }))
    },
    setSidebarWidth: (value: number): void => {
      settle(normalize({ ...intentOf(snapshot), sidebarWidth: clampSidebarWidth(value) }))
    },
    setAuxiliaryThread: (threadId: string | null): void => {
      settle({ auxiliaryThread: threadId })
    },
    claimAuxiliaryThread: (threadId: string): boolean => {
      if (
        disposed ||
        (snapshot.auxiliaryThread !== null && snapshot.auxiliaryThread !== threadId)
      ) {
        return false
      }
      settle({ auxiliaryThread: threadId })
      return true
    },
    setAuxiliaryWidth: (value: number): void => {
      settle({ auxiliaryWidth: clampAuxiliaryWidth(value, snapshot) })
    },
    setTodoThread: (threadId: string | null): void => {
      commit({ todoThread: threadId })
    },
    setAuxiliaryFullscreen: (fullscreen: boolean): void => {
      commit({ auxiliaryFullscreen: fullscreen })
    },
    toggleAuxiliaryFullscreen: (): void => {
      commit({ auxiliaryFullscreen: !snapshot.auxiliaryFullscreen })
    },
    forgetThread: (threadId: string): void => {
      settle({
        auxiliaryThread: snapshot.auxiliaryThread === threadId ? null : snapshot.auxiliaryThread,
        todoThread: snapshot.todoThread === threadId ? null : snapshot.todoThread,
      })
    },
    setSplitterActivity: (next: SplitterActivity): void => {
      activity('sidebar', next)
    },
    setAuxiliarySplitterActivity: (next: SplitterActivity): void => {
      activity('auxiliary', next)
    },
    dispose: (): void => {
      if (disposed) {
        return
      }
      flush()
      disposed = true
      detachPersistence?.()
      detachPersistence = undefined
    },
  }
}
