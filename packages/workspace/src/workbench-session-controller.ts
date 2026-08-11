import * as v from 'valibot'

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

type Entry = ConversationEntry | SurfaceEntry

interface ConversationEntry {
  readonly kind: 'conversation'
  readonly threadId: ConversationId
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

function setConversationTitle(
  state: WorkbenchState,
  threadId: ConversationId,
  title: string,
): WorkbenchState {
  const index = indexOfThread(state, threadId)
  const entry = state.entries[index]

  /* 同引用返回 = 订阅者不会被唤醒。改名不该让整条标签条重渲染。 */
  if (entry?.kind !== 'conversation' || entry.title === title) {
    return state
  }

  return settle(
    state.entries.map((candidate, candidateIndex) =>
      candidateIndex === index ? { ...entry, title } : candidate,
    ),
    state.activeIndex,
  )
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
 * 标题跟着存。它是 threads 表那一列的副本，而副本要有一条说得出名字的校正
 * 路径 —— setConversationTitle 就是它。不存的代价是恢复出来的第一帧全是没有
 * 名字的标签，那正是这次要消灭的「先画错的、再改对」。
 */
const DOCUMENT = v.object({
  entries: v.array(
    v.union([
      v.object({
        kind: v.literal('conversation'),
        threadId: v.custom<ConversationId>((value) => typeof value === 'string' && value !== ''),
        title: v.string(),
      }),
      v.object({
        kind: v.literal('surface'),
        surfaceId: v.custom<SurfaceId>((value) => typeof value === 'string' && isSurfaceId(value)),
      }),
    ]),
  ),
  activeIndex: v.pipe(v.number(), v.finite()),
})

function encode(state: WorkbenchState): string {
  return JSON.stringify({ entries: state.entries, activeIndex: state.activeIndex })
}

/**
 * 读回上一次那一份。读不懂就当没有。
 *
 * 整份要么全收要么全丢，不逐字段兜底 —— 与 workspace-layout-store 那份的取舍
 * 相反，理由也相反：那边每个字段都有一个说得通的默认值，而这里一格指向不认识
 * 的表面的标签，点开它只会是一个错误，比少一格更坏。
 *
 * 不抛。启动路径上没有人接得住，而「上次的标签页没了」不该升级成「这次打不
 * 开」。夹紧仍然交给 settle：界内不变量只有一处实现。
 */
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

  const read = v.safeParse(DOCUMENT, parsed)

  if (!read.success || read.output.entries.length === 0) {
    return INITIAL_STATE
  }

  return settle(read.output.entries, read.output.activeIndex)
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
  /**
   * 每变一次样，把整份写回去。
   *
   * 不攒、不防抖。这些变化都是人点出来的（开一格、关一格、拖一下），不在任何
   * 热路径上；而攒一会儿再写，崩在攒的那一刻丢掉的正是人刚做的那一下 —— 那就
   * 是这次要修的毛病本身。
   */
  readonly persist?: (document: string) => void
}

export function createWorkbenchSessionController(
  options: WorkbenchSessionOptions = {},
): WorkbenchSessionStore {
  const { persist } = options

  let state = decode(options.restored)
  let snapshot = project(state)
  const listeners = new Set<() => void>()

  function commit(next: WorkbenchState): void {
    /* 同引用即无变化：不重新投影，不唤醒订阅者。 */
    if (next === state) {
      return
    }

    state = next
    snapshot = project(state)

    for (const listener of listeners) {
      listener()
    }

    /* 先让屏幕跟上，再落盘：写是这一次变化的后果，不是它的前提。 */
    persist?.(encode(state))
  }

  return {
    getSnapshot: () => snapshot,

    subscribe(listener) {
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
    setConversationTitle: (threadId, title) => {
      commit(setConversationTitle(state, threadId, title))
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
  }
}
