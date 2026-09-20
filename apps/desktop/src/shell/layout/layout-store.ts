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
  /** 辅助面板铺满主区+右栏的瞬时态；不落盘，面板一收起就清（见 AuxiliaryDock）。 */
  readonly auxiliaryFullscreen: boolean
  /** 外壳此刻多宽。null = 首帧还没量到，窗口这一维暂不设限。瞬时态，不落盘。 */
  readonly viewportWidth: number | null
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

/* 辅助列的上限还要看窗口剩多少（见 auxiliaryMaxWidth），所以钳制要连布局一起看。 */
const clampAuxiliaryWidth = (value: number, layout: SidebarDock): number =>
  clampWidth(value, {
    minWidth: WORKSPACE_LAYOUT.auxiliary.minWidth,
    maxWidth: auxiliaryMaxWidth(layout),
  })

/*
 * 一份意图只在一个地方钳制：读盘、拖拽、侧栏开合、窗口改宽四条路都经过这里，调用方
 * 给什么数都行，落进快照的一定在界内。两侧宽度同一条规矩 —— 侧栏的上下限是产品常量，
 * 辅助列多一维窗口。
 */
function normalize(intent: LayoutIntent, viewportWidth: number | null): LayoutIntent {
  const sidebarWidth = clampSidebarWidth(intent.sidebarWidth)
  const auxiliaryWidth = clampAuxiliaryWidth(intent.auxiliaryWidth, { ...intent, viewportWidth })

  return sidebarWidth === intent.sidebarWidth && auxiliaryWidth === intent.auxiliaryWidth
    ? intent
    : { ...intent, sidebarWidth, auxiliaryWidth }
}

function intentOf(state: LayoutIntent): LayoutIntent {
  return {
    sidebarOpen: state.sidebarOpen,
    sidebarWidth: state.sidebarWidth,
    auxiliaryThread: state.auxiliaryThread,
    auxiliaryWidth: state.auxiliaryWidth,
  }
}

/*
 * 逐键比较，不逐字段手写。
 *
 * 手写的那一版要在一个条件里列出快照的每一个字段，而漏掉一个的后果是静默的：store
 * 不再为这个字段发通知，界面永远停在旧值，不报错也不崩。加字段时改这里就够了。
 */
function shallowEqual(left: object, right: object): boolean {
  const before = left as Record<string, unknown>
  const after = right as Record<string, unknown>

  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (before[key] !== after[key]) {
      return false
    }
  }

  return true
}

export type WorkspaceLayoutStore = ReturnType<typeof createWorkspaceLayoutStore>

export function createWorkspaceLayoutStore(persisted: Preference<LayoutIntent>) {
  let disposed = false
  let detachPersistence: (() => void) | undefined
  let snapshot: WorkspaceLayoutState = Object.freeze({
    ...normalize(persisted.read(), null),
    todoThread: null,
    splitter: 'idle',
    splitterRegion: 'sidebar',
    auxiliaryFullscreen: false,
    viewportWidth: null,
  })
  const store = createExternalStore({
    read: () => snapshot,
    activate: () => {
      if (disposed) {
        return undefined
      }
      const stop = persisted.subscribe(() => {
        commit(normalize(persisted.read(), snapshot.viewportWidth))
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
    if (shallowEqual(snapshot, next)) {
      return false
    }
    snapshot = Object.freeze(next)
    store.notify()
    return true
  }
  function flush(): void {
    const intent = intentOf(snapshot)
    if (!shallowEqual(intent, persisted.read())) {
      persisted.write(intent)
    }
  }
  function settle(patch: Partial<WorkspaceLayoutState>): void {
    if (commit(patch) && snapshot.splitter !== 'drag') {
      flush()
    }
  }
  /* 意图类改动只有这一条路：先钳到界内，再落进快照。 */
  function intend(patch: Partial<LayoutIntent>): void {
    settle(normalize({ ...intentOf(snapshot), ...patch }, snapshot.viewportWidth))
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
      intend({ sidebarOpen: open })
    },
    toggleSidebar: (): void => {
      intend({ sidebarOpen: !snapshot.sidebarOpen })
    },
    setSidebarWidth: (value: number): void => {
      intend({ sidebarWidth: value })
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
      intend({ auxiliaryWidth: value })
    },
    /*
     * 窗口改宽只改上限，不改用户的意图：快照里那份宽度可能因此被收窄，但窗口再宽回来
     * 它不会自己长回去 —— 拖出来的宽度是用户的选择，不是窗口的因变量。
     *
     * 走 commit 不走 settle：窗口拖动是每帧一次的通报，每帧落一次盘没有意义；被收窄
     * 的值反正会在下一次 settle、或退出时写回去。
     */
    setViewportWidth: (width: number): void => {
      /* 量不到就不设限：一个非有限的数会把整条上限算式变成 NaN。 */
      if (!Number.isFinite(width)) {
        return
      }
      const viewportWidth = Math.round(width)
      if (viewportWidth === snapshot.viewportWidth) {
        return
      }
      commit({ ...normalize(intentOf(snapshot), viewportWidth), viewportWidth })
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
