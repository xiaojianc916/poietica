import type { SplitterActivity } from '@poietica/design-system'
import { createExternalStore, createPreference } from '@poietica/external-store'
import { warn } from '@poietica/problem'
import { WORKSPACE_LAYOUT } from '@poietica/workspace'
import { useSyncExternalStore } from 'react'
import * as v from 'valibot'

export type { SplitterActivity }

/** 哪个区域的分隔条正在被操作。指针捕获保证同一时刻只有一个。 */
export type SplitterRegion = 'sidebar' | 'browser'

/**
 * 外壳区域布局的唯一所有者：侧栏与浏览器共用这一台状态机。
 *
 * 可见性与宽度跨会话保留；splitter 是本次交互内的瞬时态 —— 它不能交给浏览器的
 * :hover，指针捕获期间那份 hover 按规范指向捕获元素，松手后不保证当帧纠正。
 */
export interface WorkspaceLayoutState {
  readonly sidebarOpen: boolean
  readonly sidebarWidth: number
  /** 哪一条对话把浏览器开着。null = 没有对话开着它。 */
  readonly browserThread: string | null
  readonly browserWidth: number
  readonly splitter: SplitterActivity
  readonly splitterRegion: SplitterRegion
}

/** 落盘的只有意图，不含瞬时的拖拽态。 */
interface LayoutIntent {
  readonly sidebarOpen: boolean
  readonly sidebarWidth: number
  readonly browserThread: string | null
  readonly browserWidth: number
}

const { sidebar, browser } = WORKSPACE_LAYOUT

const DEFAULT_INTENT: LayoutIntent = {
  sidebarOpen: true,
  sidebarWidth: sidebar.defaultWidth,
  browserThread: null,
  browserWidth: browser.defaultWidth,
}

const clampTo = (bounds: { minWidth: number; maxWidth: number }) => (width: number) =>
  Math.min(bounds.maxWidth, Math.max(bounds.minWidth, Math.round(width)))

const clampSidebarWidth = clampTo(sidebar)
const clampBrowserWidth = clampTo(browser)

/* 持久化形状由 schema 声明，逐字段兜底交给 valibot，不手写 typeof 校验。 */
const width = (clamp: (value: number) => number, fallback: number) =>
  v.fallback(v.pipe(v.number(), v.finite(), v.transform(clamp)), fallback)

const PersistedLayoutSchema = v.object({
  sidebarOpen: v.fallback(v.boolean(), DEFAULT_INTENT.sidebarOpen),
  sidebarWidth: width(clampSidebarWidth, DEFAULT_INTENT.sidebarWidth),
  browserThread: v.fallback(v.nullable(v.string()), DEFAULT_INTENT.browserThread),
  browserWidth: width(clampBrowserWidth, DEFAULT_INTENT.browserWidth),
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

/* 本模块只拥有用户意图，不拥有视口：意图一旦被环境覆盖就再也还原不回来。 */
let intent = persisted.read()
let splitter: SplitterActivity = 'idle'
let splitterRegion: SplitterRegion = 'sidebar'
let snapshot: WorkspaceLayoutState = { ...intent, splitter, splitterRegion }

function publish(): void {
  const next: WorkspaceLayoutState = { ...intent, splitter, splitterRegion }

  if (
    next.sidebarOpen === snapshot.sidebarOpen &&
    next.sidebarWidth === snapshot.sidebarWidth &&
    next.browserThread === snapshot.browserThread &&
    next.browserWidth === snapshot.browserWidth &&
    next.splitter === snapshot.splitter &&
    next.splitterRegion === snapshot.splitterRegion
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
  intent = next
  publish()

  if (splitter !== 'drag') {
    persisted.write(next)
  }
}

function activity(region: SplitterRegion, next: SplitterActivity): void {
  if (next === splitter && region === splitterRegion) {
    return
  }

  const wasDragging = splitter === 'drag'

  splitter = next
  splitterRegion = region
  publish()

  /* 离开拖拽的那一刻，把期间累积的宽度一次落盘。 */
  if (wasDragging) {
    persisted.write(intent)
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
  setSidebarWidth: (value: number): void => {
    settle({ ...intent, sidebarWidth: clampSidebarWidth(value) })
  },

  /* 开合就是归属：浏览器归这条对话，或者不归任何人。 */
  setBrowserThread: (threadId: string | null): void => {
    settle({ ...intent, browserThread: threadId })
  },
  setBrowserWidth: (value: number): void => {
    settle({ ...intent, browserWidth: clampBrowserWidth(value) })
  },

  /* 两个区域各一个稳定引用：RegionSplitter 卸载时要靠它收回交互态。 */
  setSplitterActivity: (next: SplitterActivity): void => {
    activity('sidebar', next)
  },
  setBrowserSplitterActivity: (next: SplitterActivity): void => {
    activity('browser', next)
  },
}

export function useWorkspaceLayoutState(): WorkspaceLayoutState {
  return useSyncExternalStore(store.subscribe, store.read, store.read)
}
