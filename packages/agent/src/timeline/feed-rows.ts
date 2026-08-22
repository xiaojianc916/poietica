import { isRenderable } from './renderable'
import {
  isTerminal,
  type TimelineItem,
  type TimelineState,
  type TurnPage,
} from './timeline-contract'
import { selectIsBusy } from './timeline-queries'

/**
 * 转录的行投影。
 *
 * 状态是分段的：封口的段跨帧按引用共享，写入只发生在活动段。行因此也按段投影 ——
 * 一段的行只在它自己变过时重算，历史不再走第二遍。
 */

export interface FeedRow {
  readonly item: TimelineItem
  /** The tail entry of a live run: the only row allowed to grow in place. */
  readonly isStreamingTail: boolean
  /**
   * 这一条属于此刻还在跑的那一轮。
   *
   * 只有工具调用会是 true：行的身份是 TimelineRow 的 memo 判据，多标一行就多白渲染
   * 一行。turn-identity.test.ts 守着这条。
   */
  readonly isInFlight: boolean
}

/** 空态交出同一个数组：下游按引用判等。 */
const NO_ROWS: readonly FeedRow[] = []

/* 一行的身份，和它描述的那一条一样长寿。 */
const ROWS = new WeakMap<TimelineItem, FeedRow>()

function toRow(item: TimelineItem, isStreamingTail: boolean, isInFlight: boolean): FeedRow {
  const held = ROWS.get(item)

  if (
    held !== undefined &&
    held.isStreamingTail === isStreamingTail &&
    held.isInFlight === isInFlight
  ) {
    return held
  }

  const row: FeedRow = { item, isStreamingTail, isInFlight }

  ROWS.set(item, row)

  return row
}

/** 两个数组从头开始有多少项是同一个对象。指针比较，不分配。 */
export function sharedPrefix(before: readonly object[], after: readonly object[]): number {
  const limit = Math.min(before.length, after.length)
  let index = 0

  while (index < limit && before[index] === after[index]) {
    index += 1
  }

  return index
}

interface PageRows {
  readonly live: boolean
  readonly rows: readonly FeedRow[]
}

/* 一段的行，随这一段一起生灭。 */
const PAGES = new WeakMap<TurnPage, PageRows>()

function rowsOf(page: TurnPage, live: boolean): readonly FeedRow[] {
  const held = PAGES.get(page)

  if (held !== undefined && held.live === live) {
    return held.rows
  }

  const rows: FeedRow[] = []

  for (const item of page.items) {
    if (isRenderable(item)) {
      rows.push(toRow(item, false, live && inFlight(item)))
    }
  }

  PAGES.set(page, { live, rows })

  return rows
}

/* 终态不在飞。判据不在这里重写一遍：isTerminal 归 timeline-contract。 */
function inFlight(item: TimelineItem): boolean {
  return item.type === 'tool_call' && !isTerminal(item.status)
}

/**
 * 活动段的行，末尾那一条按需标成流式。
 *
 * 会长大的只有回答，而且只在一轮还在跑的时候。缓存里那一份不带这个记号，所以这里
 * 复制一次 —— 代价是这一轮的长度。
 */
function tailRows(page: TurnPage, live: boolean): readonly FeedRow[] {
  const rows = rowsOf(page, live)
  const last = rows.length - 1
  const tail = rows[last]

  if (!live || tail === undefined || tail.item.type !== 'agent_text') {
    return rows
  }

  const grown = rows.slice()

  grown[last] = toRow(tail.item, true, tail.isInFlight)

  return grown
}

interface Feed {
  readonly sealed: readonly TurnPage[]
  readonly prefix: readonly FeedRow[]
  readonly active: TurnPage
  readonly live: boolean
  readonly rows: readonly FeedRow[]
}

/* 按对话记账：首段的页对象随对话一起生灭。 */
const FEEDS = new WeakMap<TurnPage, Feed>()

function sealedRows(pages: readonly TurnPage[]): readonly FeedRow[] {
  const rows: FeedRow[] = []

  for (const page of pages) {
    for (const row of rowsOf(page, false)) {
      rows.push(row)
    }
  }

  return rows
}

/** 前缀没换、尾巴逐项相同，就交还上一份数组：下游按引用判等。 */
function settledRows(
  held: Feed | undefined,
  prefix: readonly FeedRow[],
  tail: readonly FeedRow[],
): readonly FeedRow[] | undefined {
  if (held === undefined || held.prefix !== prefix) {
    return undefined
  }

  if (held.rows.length !== prefix.length + tail.length) {
    return undefined
  }

  for (let index = 0; index < tail.length; index += 1) {
    if (held.rows[prefix.length + index] !== tail[index]) {
      return undefined
    }
  }

  return held.rows
}

export function selectFeedRows(state: TimelineState): readonly FeedRow[] {
  const anchor = state.sealed[0] ?? state.active
  const live = selectIsBusy(state)
  const held = FEEDS.get(anchor)

  if (
    held !== undefined &&
    held.sealed === state.sealed &&
    held.active === state.active &&
    held.live === live
  ) {
    return held.rows
  }

  /* 封口段只在换段的那一帧重拼；流式追加时它一个字节都不动。 */
  const prefix =
    held !== undefined && held.sealed === state.sealed ? held.prefix : sealedRows(state.sealed)

  const tail = tailRows(state.active, live)
  const joined = tail.length === 0 ? prefix : prefix.concat(tail)
  const rows = settledRows(held, prefix, tail) ?? (joined.length === 0 ? NO_ROWS : joined)

  FEEDS.set(anchor, { sealed: state.sealed, prefix, active: state.active, live, rows })

  return rows
}
