import { createExternalStore, createPreference, warn } from '@poietica/core'
import { useSyncExternalStore } from 'react'
import * as v from 'valibot'

import { WORKSPACE_LAYOUT } from './workspace-layout'

/** 分隔条的交互态。写入方只有分隔条的指针处理器。 */
export type SplitterActivity = 'idle' | 'hover' | 'drag'

/**
 * 工作区布局状态的唯一所有者。
 *
 * 可见性与宽度跨会话保留；splitter 是本次交互内的瞬时态。它不能交给浏览器的
 * :hover —— 指针捕获期间那份 hover 按规范指向捕获元素，松手后不保证当帧纠正。
 */
export interface WorkspaceLayoutState {
  readonly sidebarOpen: boolean
  readonly sidebarWidth: number
  readonly splitter: SplitterActivity
}

/** 落盘的只有意图，不含瞬时的拖拽态。 */
interface LayoutIntent {
  readonly sidebarOpen: boolean
  readonly sidebarWidth: number
}

const DEFAULT_INTENT: LayoutIntent = {
  sidebarOpen: true,
  sidebarWidth: WORKSPACE_LAYOUT.sidebar.defaultWidth,
}

function clampSidebarWidth(width: number): number {
  return Math.min(
    WORKSPACE_LAYOUT.sidebar.maxWidth,
    Math.max(WORKSPACE_LAYOUT.sidebar.minWidth, Math.round(width)),
  )
}

/* 持久化形状由 schema 声明，逐字段兜底交给 valibot，不手写 typeof 校验。 */
const PersistedLayoutSchema = v.object({
  sidebarOpen: v.fallback(v.boolean(), DEFAULT_INTENT.sidebarOpen),
  sidebarWidth: v.fallback(
    v.pipe(v.number(), v.finite(), v.transform(clampSidebarWidth)),
    DEFAULT_INTENT.sidebarWidth,
  ),
})

const FAILURE = {
  read: '读不出布局偏好，回到默认布局',
  write: '写不进布局偏好，下次启动回到默认布局',
}

const persisted = createPreference<LayoutIntent>({
  key: 'poietica.workspace.layout.v1',
  fallback: DEFAULT_INTENT,
  decode: (raw) => v.parse(PersistedLayoutSchema, JSON.parse(raw)),
  encode: (value) => JSON.stringify(value),
  onFailure: ({ stage, cause }) => {
    warn(FAILURE[stage], { scope: 'workspace-layout', cause })
  },
})

/*
 * 本模块只拥有用户意图，不拥有视口：窄视口改用抽屉属于呈现降级，由渲染层
 * 从布局模式派生。意图一旦被环境覆盖就再也还原不回来。
 */
let intent = persisted.read()
let splitter: SplitterActivity = 'idle'
let snapshot: WorkspaceLayoutState = { ...intent, splitter }

function publish(): void {
  const next: WorkspaceLayoutState = { ...intent, splitter }

  if (
    next.sidebarOpen === snapshot.sidebarOpen &&
    next.sidebarWidth === snapshot.sidebarWidth &&
    next.splitter === snapshot.splitter
  ) {
    return
  }

  snapshot = next
  store.notify()
}

/* 另一个窗口改了同一份布局：意图以那一侧为准，本侧的拖拽态不受影响。 */
function adopt(): void {
  intent = persisted.read()
  publish()
}

const store = createExternalStore<WorkspaceLayoutState>({
  read: () => snapshot,
  activate: () => persisted.subscribe(adopt),
})

/*
 * 只在离散的用户意图落定时写盘。拖拽期间每帧只改内存，离开 drag 的那一次收尾
 * 落盘，因此不需要 requestAnimationFrame 合并，也不需要定时器。
 */
function settle(next: LayoutIntent): void {
  if (next.sidebarOpen === intent.sidebarOpen && next.sidebarWidth === intent.sidebarWidth) {
    return
  }

  intent = next
  publish()

  if (splitter !== 'drag') {
    persisted.write(next)
  }
}

export const workspaceLayoutStore = {
  subscribe: store.subscribe,
  getSnapshot: (): WorkspaceLayoutState => snapshot,
  setSidebarOpen: (open: boolean): void => {
    settle({ ...intent, sidebarOpen: open })
  },
  toggleSidebar: (): void => {
    settle({ ...intent, sidebarOpen: !intent.sidebarOpen })
  },
  setSidebarWidth: (width: number): void => {
    settle({ ...intent, sidebarWidth: clampSidebarWidth(width) })
  },
  setSplitterActivity: (next: SplitterActivity): void => {
    if (next === splitter) {
      return
    }

    const wasDragging = splitter === 'drag'

    splitter = next
    publish()

    /* 离开拖拽的那一刻，把期间累积的宽度一次落盘。 */
    if (wasDragging) {
      persisted.write(intent)
    }
  },
}

export function useWorkspaceLayoutState(): WorkspaceLayoutState {
  return useSyncExternalStore(store.subscribe, store.read, store.read)
}
