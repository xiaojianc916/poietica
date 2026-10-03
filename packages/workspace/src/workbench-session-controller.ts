import { z } from 'zod'
import {
  DEFAULT_SURFACE_ID,
  describeSurface,
  isSurfaceId,
  type SurfaceId,
} from './surface-registry'
import type {
  ConversationId,
  OpenConversationRequest,
  OpenSurfaceRequest,
  WorkbenchSessionStore,
  WorkbenchSurfaceViewModel,
  WorkbenchTabId,
  WorkbenchTabViewModel,
  WorkbenchViewModel,
} from './workbench'
import { createWorkbenchPersistence } from './workbench-persistence'

type Entry = ConversationEntry | SurfaceEntry

interface ConversationEntry {
  readonly kind: 'conversation'
  readonly threadId: ConversationId
  /**
   * 标签上的那一行字，只活在这一趟进程里。
   *
   * 它不是落盘物：标题的正本是 threads 表那一列，这里存一份副本只会在改名之后
   * 分叉。读回来的标签先没有名字，由会话列表到达时补齐（见 retitle）。
   */
  readonly title: string
}

interface SurfaceEntry {
  readonly kind: 'surface'
  readonly surfaceId: SurfaceId
}

/**
 * 工作台状态。
 *
 * 活动标签由索引持有，不是第二个 id 字段：只要 tabs 非空、activeIndex 落在
 * 界内，「恰好一个 active」就是结构性的真，不可能不成立。
 */
interface WorkbenchState {
  readonly entries: readonly Entry[]
  readonly activeIndex: number
}

const DEFAULT_ENTRY: SurfaceEntry = { kind: 'surface', surfaceId: DEFAULT_SURFACE_ID }

const INITIAL_STATE: WorkbenchState = { entries: [DEFAULT_ENTRY], activeIndex: 0 }

type Projection = {
  readonly inactiveTab: WorkbenchTabViewModel
  readonly activeTab: WorkbenchTabViewModel
  readonly surface: WorkbenchSurfaceViewModel
}

const projectionCache = new WeakMap<Entry, Projection>()

function entryId(entry: Entry): WorkbenchTabId {
  return entry.kind === 'conversation'
    ? `conversation:${entry.threadId}`
    : `surface:${entry.surfaceId}`
}

function entryTitle(entry: Entry): string {
  return entry.kind === 'conversation' ? entry.title : describeSurface(entry.surfaceId).title
}

function buildProjection(entry: Entry): Projection {
  const tabId = entryId(entry)
  const title = entryTitle(entry)

  const inactiveTab: WorkbenchTabViewModel =
    entry.kind === 'conversation'
      ? {
          id: tabId,
          kind: 'conversation',
          threadId: entry.threadId,
          title,
          isActive: false,
          canClose: true,
        }
      : {
          id: tabId,
          kind: 'surface',
          surfaceId: entry.surfaceId,
          title,
          isActive: false,
          canClose: true,
        }

  const activeTab: WorkbenchTabViewModel = { ...inactiveTab, isActive: true }

  const surface: WorkbenchSurfaceViewModel =
    entry.kind === 'conversation'
      ? {
          kind: 'conversation',
          tabId,
          threadId: entry.threadId,
          title,
        }
      : {
          kind: 'surface',
          tabId,
          surfaceId: entry.surfaceId,
          title,
        }

  return { inactiveTab, activeTab, surface }
}

function projectionOf(entry: Entry): Projection {
  const cached = projectionCache.get(entry)

  if (cached) {
    return cached
  }

  const projection = buildProjection(entry)
  projectionCache.set(entry, projection)

  return projection
}

function normalizeActiveIndex(activeIndex: number): number {
  if (!Number.isFinite(activeIndex)) {
    return 0
  }

  return Math.trunc(activeIndex)
}

/** 界内夹紧。所有 reducer 出口都过它一次，activeIndex 因此永不越界。 */
function settle(entries: readonly Entry[], activeIndex: number): WorkbenchState {
  if (entries.length === 0) {
    return INITIAL_STATE
  }

  const normalizedActiveIndex = normalizeActiveIndex(activeIndex)

  return {
    entries,
    activeIndex: Math.min(Math.max(normalizedActiveIndex, 0), entries.length - 1),
  }
}

function indexOfId(state: WorkbenchState, tabId: WorkbenchTabId): number {
  return state.entries.findIndex((entry) => entryId(entry) === tabId)
}

function indexOfThread(state: WorkbenchState, threadId: ConversationId): number {
  return state.entries.findIndex(
    (entry) => entry.kind === 'conversation' && entry.threadId === threadId,
  )
}

function insertRightOfActive(state: WorkbenchState, entry: Entry): WorkbenchState {
  const at = state.activeIndex + 1
  const entries = [...state.entries.slice(0, at), entry, ...state.entries.slice(at)]

  return settle(entries, at)
}

/* ── reducer：全部是全函数，无一处 throw ─────────────────────────── */

function openSurface(state: WorkbenchState, surfaceId: SurfaceId): WorkbenchState {
  const existing = indexOfId(state, `surface:${surfaceId}`)

  return existing >= 0
    ? settle(state.entries, existing)
    : insertRightOfActive(state, { kind: 'surface', surfaceId })
}

/**
 * 打开一条已有对话。
 *
 * 正在看的那一格本身就是会话形态（对话，或启动时的 ai 表面）时就地替换：
 * 侧栏是导航，不是标签工厂。其余形态插在活动标签右侧。
 */
/**
 * 给一格会话标签补上名字。
 *
 * 标题的正本是 threads 表那一列，所以恢复出来的标签一开始是空的：会话列表到达时
 * 由调用方把名字交回来。找不到那一格、或名字没变，都返回同一个引用 —— 不唤醒订阅者。
 */
function retitle(state: WorkbenchState, threadId: ConversationId, title: string): WorkbenchState {
  const index = indexOfThread(state, threadId)
  const entry = index < 0 ? undefined : state.entries[index]

  if (entry === undefined || entry.kind !== 'conversation' || entry.title === title) {
    return state
  }

  const entries = [...state.entries]

  entries[index] = { kind: 'conversation', threadId: entry.threadId, title }

  return { entries, activeIndex: state.activeIndex }
}

function openConversation(state: WorkbenchState, request: OpenConversationRequest): WorkbenchState {
  const existing = indexOfThread(state, request.threadId)

  if (existing >= 0) {
    return settle(state.entries, existing)
  }

  const entry: ConversationEntry = {
    kind: 'conversation',
    threadId: request.threadId,
    title: request.title,
  }
  const active = state.entries[state.activeIndex]
  const replaceable =
    active !== undefined &&
    (active.kind === 'conversation' ||
      (active.kind === 'surface' && active.surfaceId === DEFAULT_SURFACE_ID))

  if (!replaceable) {
    return insertRightOfActive(state, entry)
  }

  return settle(
    state.entries.map((candidate, index) => (index === state.activeIndex ? entry : candidate)),
    state.activeIndex,
  )
}

function openConversationInNewTab(
  state: WorkbenchState,
  request: OpenConversationRequest,
): WorkbenchState {
  const existing = indexOfThread(state, request.threadId)

  return existing >= 0
    ? settle(state.entries, existing)
    : insertRightOfActive(state, {
        kind: 'conversation',
        threadId: request.threadId,
        title: request.title,
      })
}

/**
 * 拿掉一格并决定接下来看哪一格：右邻居优先，没有就左邻居，一格不剩回到启动态。
 *
 * 「人按了叉」与「这条对话没了」两个入口共用这一段，两处各写一遍必然分叉。
 */
function dropAt(state: WorkbenchState, index: number): WorkbenchState {
  if (index < 0 || index >= state.entries.length) {
    return state
  }

  const entries = state.entries.filter((_entry, candidate) => candidate !== index)
  const nextActive = index < state.activeIndex ? state.activeIndex - 1 : state.activeIndex

  return settle(entries, nextActive)
}

function moveTab(
  state: WorkbenchState,
  tabId: WorkbenchTabId,
  targetIndex: number,
): WorkbenchState {
  const from = indexOfId(state, tabId)
  const source = state.entries[from]

  if (from < 0 || source === undefined) {
    return state
  }

  const to = Math.min(Math.max(targetIndex, 0), state.entries.length - 1)

  if (from === to) {
    return state
  }

  /*
   * targetIndex 是这个标签最终应当所在的位置。先移除源元素，数组已经变短，
   * 在短数组的 to 处插入，落点正好是结果里的 to —— 向右拖动不需要额外补偿。
   */
  const entries = [...state.entries]
  entries.splice(from, 1)
  entries.splice(to, 0, source)

  const activeEntry = state.entries[state.activeIndex]

  return settle(entries, activeEntry === undefined ? to : entries.indexOf(activeEntry))
}

/* ── 投影 ─────────────────────────────────────────────────────────── */

function project(state: WorkbenchState): WorkbenchViewModel {
  const activeEntry = state.entries[state.activeIndex] ?? DEFAULT_ENTRY

  return {
    activeTabId: entryId(activeEntry),
    tabs: state.entries.map((entry, index) =>
      index === state.activeIndex ? projectionOf(entry).activeTab : projectionOf(entry).inactiveTab,
    ),
    activeSurface: projectionOf(activeEntry).surface,
  }
}

/* ── 文档：存下去的那一份，读回来的那一份 ────────────────────────── */

/**
 * 存下去的形状就是状态本身，不另立一份传输格式。
 *
 * 原生那一侧不解释它。一格标签指向的表面有哪些，唯一的注册处是
 * surface-registry，而那一份只存在于这里 —— 让 Rust 去声明一个它验不动的
 * 结构，只会把「没人验」写成「看起来验过」。所以库那边存的是一列 TEXT，
 * 这份 schema 是它唯一的读者，也是它唯一的作者。
 *
 * 标题不进来：它是 threads 表那一列的副本，存下来就是给改名留一条分叉的路。
 * 恢复出来的标签先没有名字，会话列表一到就由 retitle 补上。
 */
const DOCUMENT = z.object({
  entries: z.array(
    z.union([
      z.object({
        kind: z.literal('conversation'),
        threadId: z.custom<ConversationId>((value) => typeof value === 'string' && value !== ''),
      }),
      z.object({
        kind: z.literal('surface'),
        surfaceId: z.string(),
      }),
    ]),
  ),
  activeIndex: z.number(),
})

/** 落的这一份里，会话标签只有身份，没有标题。 */
function encode(state: WorkbenchState): string {
  return JSON.stringify({
    entries: state.entries.map((entry) =>
      entry.kind === 'conversation' ? { kind: entry.kind, threadId: entry.threadId } : entry,
    ),
    activeIndex: state.activeIndex,
  })
}

/** Unregistered surfaces are not restorable; unrelated conversation tabs remain valid. */
function decode(document: string | null | undefined): WorkbenchState {
  if (document === null || document === undefined) {
    return INITIAL_STATE
  }

  let parsed: unknown

  try {
    parsed = JSON.parse(document)
  } catch {
    return INITIAL_STATE
  }

  const read = DOCUMENT.safeParse(parsed)

  if (!read.success || read.data.entries.length === 0) {
    return INITIAL_STATE
  }

  const entries: Entry[] = []
  const restoredIndex = normalizeActiveIndex(read.data.activeIndex)
  let activeIndex = 0

  for (const [index, entry] of read.data.entries.entries()) {
    if (entry.kind === 'surface') {
      if (!isSurfaceId(entry.surfaceId)) {
        continue
      }
      entries.push({ kind: 'surface', surfaceId: entry.surfaceId })
    } else {
      /* 名字等会话列表到了再补：这一趟先认身份。 */
      entries.push({ kind: 'conversation', threadId: entry.threadId, title: '' })
    }
    if (index < restoredIndex) {
      activeIndex += 1
    }
  }

  return settle(entries, activeIndex)
}

/* ── 工厂 ─────────────────────────────────────────────────────────── */

/** 上一次留下的那一份，以及往哪里写回去。 */
export interface WorkbenchSessionOptions {
  /**
   * 上一次关掉时存下的那份文档，读不到就是 null。
   *
   * 由调用方读，不由这里读：这个包不认识 IPC，也不该认识。它只认识这份文档
   * 的形状 —— 那是它自己定的。
   */
  readonly restored?: string | null
  /** Writes complete snapshots; the owner awaits flush before disposal. */
  readonly persist?: (document: string) => void | Promise<void>
  readonly onPersistenceError?: (cause: unknown) => void
}

export function createWorkbenchSessionController(
  options: WorkbenchSessionOptions = {},
): WorkbenchSessionStore & {
  readonly flush: () => Promise<void>
  readonly dispose: () => Promise<void>
} {
  const persistence =
    options.persist === undefined
      ? null
      : createWorkbenchPersistence(options.persist, options.onPersistenceError)
  let disposed = false
  let disposing: Promise<void> | null = null

  let state = decode(options.restored)
  let snapshot = project(state)
  const listeners = new Set<() => void>()

  function commit(next: WorkbenchState): void {
    if (disposed) {
      throw new Error('Workbench session is disposed.')
    }
    /* 同引用即无变化：不重新投影，不唤醒订阅者。 */
    if (next === state) {
      return
    }

    state = next
    snapshot = project(state)
    persistence?.enqueue(encode(state))

    for (const listener of listeners) {
      listener()
    }
  }

  return {
    flush: () => persistence?.flush() ?? Promise.resolve(),
    dispose() {
      if (disposing !== null) {
        return disposing
      }
      disposed = true
      listeners.clear()
      disposing = persistence?.flush() ?? Promise.resolve()
      return disposing
    },
    getSnapshot: () => snapshot,

    subscribe(listener) {
      if (disposed) {
        throw new Error('Workbench session is disposed.')
      }
      listeners.add(listener)

      return () => {
        listeners.delete(listener)
      }
    },

    openSurface: (request: OpenSurfaceRequest) => {
      commit(openSurface(state, request.surfaceId))
    },
    openConversation: (request) => {
      commit(openConversation(state, request))
    },
    openConversationInNewTab: (request) => {
      commit(openConversationInNewTab(state, request))
    },
    activateTab: (tabId) => {
      const index = indexOfId(state, tabId)
      commit(index < 0 ? state : settle(state.entries, index))
    },
    closeTab: (tabId) => {
      commit(dropAt(state, indexOfId(state, tabId)))
    },
    closeConversation: (threadId) => {
      commit(dropAt(state, indexOfThread(state, threadId)))
    },
    moveTab: (tabId, targetIndex) => {
      commit(moveTab(state, tabId, targetIndex))
    },
    retitle: (threadId, title) => {
      commit(retitle(state, threadId, title))
    },
  }
}
