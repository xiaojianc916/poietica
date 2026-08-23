import { isRenderable } from './renderable'
import {
  isTerminal,
  type TimelineItem,
  type TimelineItemId,
  type TimelineState,
  type ToolCallTimelineItem,
  type TurnPage,
  type TurnSpan,
} from './timeline-contract'
import { selectIsBusy } from './timeline-queries'

/**
 * 转录的唯一投影：一段一次派生，屏幕按下标取行。
 *
 * 段（TurnPage）是 seq 与 id 的命名空间，不是屏幕上的一轮 —— 上一轮还在跑时插进来的
 * 那一句留在同一段里（timeline-draft 的 appendUserMessage）。屏幕上的一轮是「一条提问
 * 到下一条提问」，封条、折叠、并组、回复操作、轮次索引全部按它算。
 */

export interface FeedRow {
  readonly item: TimelineItem
  readonly isStreamingTail: boolean
  readonly isInFlight: boolean
}

export type ToolGroupKind = 'read' | 'search' | 'fetch' | 'execute' | 'write'

export interface ToolGroupPlan {
  readonly kind: ToolGroupKind
  /** 按屏幕顺序，第一条就是挂着这一组的那一行。 */
  readonly members: readonly FeedRow[]
}

/** 封条属于一轮，键就是开启这一轮的那条提问。 */
export interface TurnSealPlan {
  readonly id: TimelineItemId
  readonly startedAt: number | undefined
  readonly endedAt: number | undefined
  readonly hasProcess: boolean
  readonly isOpen: boolean
}

export interface ReplyActionPlan {
  readonly text: string
}

export interface ConversationTurn {
  readonly id: TimelineItemId
  readonly rowIndex: number
  readonly label: string
  readonly reply?: string
}

/** 屏幕要的一切，按下标问。 */
export interface Presentation {
  readonly count: number
  readonly turns: readonly ConversationTurn[]
  readonly latestOwnMessage: string | null
  readonly lastTurn: number | undefined
  readonly rowAt: (index: number) => FeedRow | undefined
  readonly groupAt: (index: number) => ToolGroupPlan | undefined
  readonly sealAt: (index: number) => TurnSealPlan | undefined
  readonly replyAt: (index: number) => ReplyActionPlan | undefined
  /** 这一行被哪一轮的封条折着；没被折就是 undefined。 */
  readonly processOf: (index: number) => TimelineItemId | undefined
  readonly indexOf: (id: string) => number
}

/** 旁白：既不是过程也不是回答，永不折叠。 */
const ASIDE: ReadonlySet<TimelineItem['type']> = new Set(['error', 'permission', 'question'])
/* 字面量而不是 TimelineItem['type']：注解成联合后 === 不再收窄。 */
const SAID = 'user_message'
const PREVIEW = 300

/** 白名单之外不并组：语义未知的几条并成一堆是信息损失。 */
const GROUPED = new Map<ToolCallTimelineItem['kind'], ToolGroupKind>([
  ['read', 'read'],
  ['edit', 'write'],
  ['search', 'search'],
  ['fetch', 'fetch'],
  ['execute', 'execute'],
])
const LEAST = 2

const NO_ROWS: readonly FeedRow[] = []
const NO_TURNS: readonly ConversationTurn[] = []
const NO_IDS: readonly TimelineItemId[] = []
const NO_GROUPS: ReadonlyMap<string, ToolGroupPlan> = new Map()
const NO_SEALS: ReadonlyMap<number, TurnSealPlan> = new Map()
const NO_REPLIES: ReadonlyMap<number, ReplyActionPlan> = new Map()
const NO_MARKS: ReadonlyMap<string, TimelineItemId> = new Map()

const ROWS = new WeakMap<TimelineItem, FeedRow>()
const SEGMENTS = new WeakMap<TurnPage, Segment>()
const SPANS = new WeakMap<readonly TurnSpan[], ReadonlyMap<number, TurnSpan>>()
const TURN_OF = new WeakMap<FeedRow, ConversationTurn>()
const FEEDS = new WeakMap<TurnPage, Held>()

interface Scan {
  readonly answered: boolean
  readonly reply: string | undefined
}

interface Staged {
  readonly row: FeedRow
  readonly rowIndex: number
  readonly answered: boolean
  readonly reply: string | undefined
}

/** 一轮的派生结果。 */
interface Stanza {
  readonly seal: TurnSealPlan | undefined
  readonly replyId: TimelineItemId | undefined
  readonly replyText: string
}

/** 一段的全部派生。段是缓存单位，也是重算单位。 */
interface Segment {
  readonly span: TurnSpan | undefined
  readonly live: boolean
  readonly sealIds: readonly TimelineItemId[]
  readonly openedHere: ReadonlySet<TimelineItemId>
  readonly rows: readonly FeedRow[]
  readonly groups: ReadonlyMap<string, ToolGroupPlan>
  readonly seals: ReadonlyMap<number, TurnSealPlan>
  readonly replies: ReadonlyMap<number, ReplyActionPlan>
  readonly marks: ReadonlyMap<string, TimelineItemId>
  readonly staged: readonly Staged[]
  /** 首个提问之前那一段留下了什么：上一段末尾那一问要连着它一起算。 */
  readonly leading: Scan
  readonly ownMessage: string | null
}

interface Held {
  readonly sealed: readonly TurnPage[]
  readonly active: TurnPage
  readonly spans: readonly TurnSpan[]
  readonly opened: ReadonlySet<TimelineItemId>
  readonly live: boolean
  readonly turns: readonly ConversationTurn[]
  readonly result: Presentation
}

function toRow(item: TimelineItem, isStreamingTail: boolean, isInFlight: boolean): FeedRow {
  const held = ROWS.get(item)

  if (
    held !== undefined &&
    held.isStreamingTail === isStreamingTail &&
    held.isInFlight === isInFlight
  ) {
    return held
  }

  const row: FeedRow = { isInFlight, isStreamingTail, item }

  ROWS.set(item, row)

  return row
}

function inFlight(item: TimelineItem): boolean {
  return item.type === 'tool_call' && !isTerminal(item.status)
}

function rowsOf(page: TurnPage, live: boolean): readonly FeedRow[] {
  const rows: FeedRow[] = []

  for (const item of page.items) {
    if (isRenderable(item)) {
      rows.push(toRow(item, false, live && inFlight(item)))
    }
  }

  const tail = rows.at(-1)

  if (live && tail !== undefined && tail.item.type === 'agent_text') {
    rows[rows.length - 1] = toRow(tail.item, true, tail.isInFlight)
  }

  return rows
}

/** 每一轮的起点。段自己那一问在 0；插进来的那些各自成轮；-1 是无主的开头。 */
function boundsIn(rows: readonly FeedRow[]): readonly number[] {
  const out: number[] = []

  for (let i = 0; i < rows.length; i += 1) {
    if (rows[i]?.item.type === SAID) {
      out.push(i)
    }
  }

  return out[0] === 0 ? out : [-1, ...out]
}

/** 末尾那段连续回答的起点；等于 until 表示这一轮还没开口。 */
function answerFrom(rows: readonly FeedRow[], from: number, until: number): number {
  let found = until

  for (let i = until - 1; i >= from; i -= 1) {
    const type = rows[i]?.item.type

    if (type === undefined || ASIDE.has(type)) {
      continue
    }

    if (type !== 'agent_text') {
      break
    }

    found = i
  }

  return found
}

/**
 * 这一轮要收进封条的行：回答之前的都是过程。
 *
 * 还在跑且这一轮尚未开口时，最近的那一条留在原地当现场 —— 它不换父节点，所以开合封条
 * 不会让任何一行搬家。
 */
function foldFrom(
  rows: readonly FeedRow[],
  answer: number,
  from: number,
  until: number,
  alive: boolean,
): readonly number[] {
  const out: number[] = []

  for (let i = from; i < answer; i += 1) {
    const type = rows[i]?.item.type

    if (type === undefined || type === SAID || ASIDE.has(type)) {
      continue
    }

    out.push(i)
  }

  if (alive && answer === until) {
    out.pop()
  }

  return out
}

/** 这一轮有没有正文：只有旁白的一轮不盖封条。 */
function bodyIn(rows: readonly FeedRow[], from: number, until: number): boolean {
  for (let i = from; i < until; i += 1) {
    const type = rows[i]?.item.type

    if (type !== undefined && type !== SAID && !ASIDE.has(type)) {
      return true
    }
  }

  return false
}

/** 这一轮还有没有东西在动：有就先不给回复操作。 */
function busyIn(rows: readonly FeedRow[], from: number, until: number): boolean {
  for (let i = from; i < until; i += 1) {
    const row = rows[i]

    if (row !== undefined && (row.isStreamingTail || row.isInFlight)) {
      return true
    }
  }

  return false
}

function speechFrom(rows: readonly FeedRow[], from: number, until: number): string {
  const said: string[] = []

  for (let i = Math.max(from, 0); i < until; i += 1) {
    const item = rows[i]?.item

    if (item?.type === 'agent_text') {
      said.push(item.text)
    }
  }

  return said.join('\n\n')
}

function firstLine(text: string): string {
  const trimmed = text.trim()
  const stop = trimmed.indexOf('\n')

  return stop < 0 ? trimmed : trimmed.slice(0, stop)
}

function leavesAMark(item: TimelineItem): boolean {
  switch (item.type) {
    case 'agent_text':
    case 'agent_thought':
      return item.text.length > 0
    case 'tool_call':
      return true
    case 'plan':
      return item.entries.length > 0
    case 'question':
      return item.resolution !== undefined
    case 'error':
    case 'permission':
    case 'user_message':
      return false
  }
}

function scan(rows: readonly FeedRow[], from: number, until: number): Scan {
  let answered = false

  for (let i = from; i < until; i += 1) {
    const item = rows[i]?.item

    if (item === undefined || !leavesAMark(item)) {
      continue
    }

    answered = true

    if (item.type === 'agent_text') {
      return { answered, reply: item.text.slice(0, PREVIEW) }
    }
  }

  return { answered, reply: undefined }
}

function groupIn(rows: readonly FeedRow[]): {
  readonly rows: readonly FeedRow[]
  readonly groups: ReadonlyMap<string, ToolGroupPlan>
} {
  let kept: FeedRow[] | undefined
  let groups: Map<string, ToolGroupPlan> | undefined
  let cursor = 0

  while (cursor < rows.length) {
    const row = rows[cursor]

    if (row === undefined) {
      cursor += 1

      continue
    }

    const kind = row.item.type === 'tool_call' ? GROUPED.get(row.item.kind) : undefined

    if (kind === undefined) {
      kept?.push(row)
      cursor += 1

      continue
    }

    let end = cursor + 1

    while (end < rows.length) {
      const next = rows[end]?.item

      if (
        next?.type !== 'tool_call' ||
        next.turn !== row.item.turn ||
        GROUPED.get(next.kind) !== kind
      ) {
        break
      }

      end += 1
    }

    if (end - cursor < LEAST) {
      kept?.push(row)
      cursor += 1

      continue
    }

    if (kept === undefined || groups === undefined) {
      kept = rows.slice(0, cursor)
      groups = new Map()
    }

    kept.push(row)
    groups.set(row.item.id, { kind, members: rows.slice(cursor, end) })
    cursor = end
  }

  return kept === undefined || groups === undefined
    ? { groups: NO_GROUPS, rows }
    : { groups, rows: kept }
}

function stageIn(rows: readonly FeedRow[]): {
  readonly staged: readonly Staged[]
  readonly leading: Scan
} {
  const marks: number[] = []

  for (let i = 0; i < rows.length; i += 1) {
    if (rows[i]?.item.type === SAID) {
      marks.push(i)
    }
  }

  const staged: Staged[] = []

  for (let i = 0; i < marks.length; i += 1) {
    const rowIndex = marks[i]
    const row = rowIndex === undefined ? undefined : rows[rowIndex]

    if (rowIndex === undefined || row === undefined) {
      continue
    }

    const found = scan(rows, rowIndex + 1, marks[i + 1] ?? rows.length)

    staged.push({ answered: found.answered, reply: found.reply, row, rowIndex })
  }

  return { leading: scan(rows, 0, marks[0] ?? rows.length), staged }
}

function buildSegment(
  page: TurnPage,
  span: TurnSpan | undefined,
  live: boolean,
  opened: ReadonlySet<TimelineItemId>,
): Segment {
  const all = rowsOf(page, live)
  const running = span?.startedAt !== undefined && span.endedAt === undefined
  const bounds = boundsIn(all)
  const plans: Stanza[] = []
  const sealIds: TimelineItemId[] = []
  const openedHere = new Set<TimelineItemId>()
  const hidden = new Set<number>()
  const marks = new Map<string, TimelineItemId>()

  for (let k = 0; k < bounds.length; k += 1) {
    const said = bounds[k] ?? -1
    const until = bounds[k + 1] ?? all.length
    const from = said + 1
    const alive = running && k === bounds.length - 1
    const answer = answerFrom(all, from, until)
    const folded = foldFrom(all, answer, from, until, alive)
    const head = said < 0 ? undefined : all[said]?.item
    /* 段自己那一问的起点由 run_started 记在 span 上；插进来的那一问只有它自己的时刻。 */
    const startedAt = head === undefined ? undefined : said === 0 ? span?.firstFrameAt : head.at
    const seal: TurnSealPlan | undefined =
      head === undefined || startedAt === undefined || !bodyIn(all, from, until)
        ? undefined
        : {
            endedAt: until < all.length ? all[until]?.item.at : span?.endedAt,
            hasProcess: folded.length > 0,
            id: head.id,
            isOpen: opened.has(head.id),
            startedAt,
          }

    if (seal !== undefined) {
      sealIds.push(seal.id)

      if (seal.isOpen) {
        openedHere.add(seal.id)
      }

      for (const one of folded) {
        const id = all[one]?.item.id

        if (id === undefined) {
          continue
        }

        marks.set(id, seal.id)

        if (!seal.isOpen) {
          hidden.add(one)
        }
      }
    }

    const tail = all[until - 1]
    const settled = !alive && !busyIn(all, from, until) && answer < until

    plans.push({
      replyId: settled && tail !== undefined ? tail.item.id : undefined,
      replyText: speechFrom(all, answer, until),
      seal,
    })
  }

  const visible = hidden.size === 0 ? all : all.filter((_, one) => !hidden.has(one))
  const grouped = groupIn(visible)
  const where = new Map<string, number>()

  for (let i = 0; i < grouped.rows.length; i += 1) {
    const id = grouped.rows[i]?.item.id

    if (id !== undefined) {
      where.set(id, i)
    }
  }

  const seals = new Map<number, TurnSealPlan>()
  const replies = new Map<number, ReplyActionPlan>()

  for (const one of plans) {
    const sealAt = one.seal === undefined ? undefined : where.get(one.seal.id)

    if (one.seal !== undefined && sealAt !== undefined) {
      seals.set(sealAt, one.seal)
    }

    const replyAt = one.replyId === undefined ? undefined : where.get(one.replyId)

    if (replyAt !== undefined) {
      replies.set(replyAt, { text: one.replyText })
    }
  }

  let ownMessage: string | null = null

  for (const row of grouped.rows) {
    if (row.item.type === SAID) {
      ownMessage = row.item.id
    }
  }

  return {
    ...stageIn(grouped.rows),
    groups: grouped.groups,
    live,
    marks: marks.size === 0 ? NO_MARKS : marks,
    openedHere,
    ownMessage,
    replies: replies.size === 0 ? NO_REPLIES : replies,
    rows: grouped.rows,
    sealIds: sealIds.length === 0 ? NO_IDS : sealIds,
    seals: seals.size === 0 ? NO_SEALS : seals,
    span,
  }
}

/** 这一段的封条开合有没有变：只问它自己那几枚，别处点开与它无关。 */
function sameOpen(held: Segment, opened: ReadonlySet<TimelineItemId>): boolean {
  for (const id of held.sealIds) {
    if (opened.has(id) !== held.openedHere.has(id)) {
      return false
    }
  }

  return true
}

function segmentOf(
  page: TurnPage,
  span: TurnSpan | undefined,
  live: boolean,
  opened: ReadonlySet<TimelineItemId>,
): Segment {
  const held = SEGMENTS.get(page)

  if (held !== undefined && held.span === span && held.live === live && sameOpen(held, opened)) {
    return held
  }

  const built = buildSegment(page, span, live, opened)

  SEGMENTS.set(page, built)

  return built
}

function spanOf(spans: readonly TurnSpan[], turn: number): TurnSpan | undefined {
  let index = SPANS.get(spans)

  if (index === undefined) {
    const built = new Map<number, TurnSpan>()

    for (const span of spans) {
      built.set(span.turn, span)
    }

    index = built
    SPANS.set(spans, built)
  }

  return index.get(turn)
}

function toTurn(row: FeedRow, rowIndex: number, reply: string | undefined): ConversationTurn {
  const held = TURN_OF.get(row)

  if (held !== undefined && held.rowIndex === rowIndex && held.reply === reply) {
    return held
  }

  const label = row.item.type === SAID ? firstLine(row.item.text) : ''
  const turn: ConversationTurn =
    reply === undefined
      ? { id: row.item.id, label, rowIndex }
      : { id: row.item.id, label, reply, rowIndex }

  TURN_OF.set(row, turn)

  return turn
}

/** 段尾那一问的应答可能落在后面的段里：往后扫，直到撞见下一个有提问的段。 */
function carriedScan(segments: readonly Segment[], from: number): Scan | undefined {
  let answered = false
  let reply: string | undefined

  for (let k = from; k < segments.length; k += 1) {
    const next = segments[k]

    if (next === undefined) {
      continue
    }

    answered = answered || next.leading.answered
    reply = reply ?? next.leading.reply

    if (next.staged.length > 0) {
      break
    }
  }

  return answered || reply !== undefined ? { answered, reply } : undefined
}

function flatStaged(segments: readonly Segment[], offsets: readonly number[]): readonly Staged[] {
  const flat: Staged[] = []

  for (let s = 0; s < segments.length; s += 1) {
    const segment = segments[s]
    const start = offsets[s]

    if (segment === undefined || start === undefined) {
      continue
    }

    for (let i = 0; i < segment.staged.length; i += 1) {
      const one = segment.staged[i]

      if (one === undefined) {
        continue
      }

      /* 一问的跨度到下一问为止，而下一问可能在后面的段里。 */
      const carried = i === segment.staged.length - 1 ? carriedScan(segments, s + 1) : undefined

      flat.push({
        answered: one.answered || (carried?.answered ?? false),
        reply: one.reply ?? carried?.reply,
        row: one.row,
        rowIndex: start + one.rowIndex,
      })
    }
  }

  return flat
}

/** 没人应答的一问并进下一格，入口行号跟着它走。 */
function turnsFrom(flat: readonly Staged[]): readonly ConversationTurn[] {
  const built: ConversationTurn[] = []
  let carried: number | undefined

  for (let i = 0; i < flat.length; i += 1) {
    const one = flat[i]

    if (one === undefined) {
      continue
    }

    if (!one.answered && i + 1 < flat.length) {
      carried = carried ?? one.rowIndex

      continue
    }

    built.push(toTurn(one.row, carried ?? one.rowIndex, one.reply))
    carried = undefined
  }

  return built
}

function railOf(
  segments: readonly Segment[],
  offsets: readonly number[],
  held: readonly ConversationTurn[] | undefined,
): readonly ConversationTurn[] {
  const built = turnsFrom(flatStaged(segments, offsets))

  if (
    held !== undefined &&
    held.length === built.length &&
    built.every((one, i) => one === held[i])
  ) {
    return held
  }

  return built.length === 0 ? NO_TURNS : built
}

export function selectPresentation(
  state: TimelineState,
  opened: ReadonlySet<TimelineItemId>,
): Presentation {
  const anchor = state.sealed[0] ?? state.active
  const live = selectIsBusy(state)
  const held = FEEDS.get(anchor)

  if (
    held !== undefined &&
    held.sealed === state.sealed &&
    held.active === state.active &&
    held.spans === state.spans &&
    held.opened === opened &&
    held.live === live
  ) {
    return held.result
  }

  const segments: Segment[] = []
  const offsets: number[] = []
  let count = 0

  for (const page of state.sealed) {
    const segment = segmentOf(page, spanOf(state.spans, page.turn), false, opened)

    segments.push(segment)
    offsets.push(count)
    count += segment.rows.length
  }

  const tail = segmentOf(state.active, spanOf(state.spans, state.active.turn), live, opened)

  segments.push(tail)
  offsets.push(count)
  count += tail.rows.length

  const seek = (index: number): { segment: Segment; at: number } | undefined => {
    if (index < 0 || index >= count) {
      return undefined
    }

    let low = 0
    let high = offsets.length - 1

    while (low < high) {
      const mid = (low + high + 1) >> 1

      if ((offsets[mid] ?? 0) <= index) {
        low = mid
      } else {
        high = mid - 1
      }
    }

    const segment = segments[low]
    const start = offsets[low]

    return segment === undefined || start === undefined ? undefined : { at: index - start, segment }
  }

  let latestOwnMessage: string | null = null
  let lastTurn: number | undefined

  for (let s = segments.length - 1; s >= 0; s -= 1) {
    const segment = segments[s]

    if (segment === undefined) {
      continue
    }

    if (lastTurn === undefined) {
      lastTurn = segment.rows.at(-1)?.item.turn
    }
    if (latestOwnMessage === null) {
      latestOwnMessage = segment.ownMessage
    }
  }

  const turns = railOf(segments, offsets, held?.turns)
  const result: Presentation = {
    count,
    groupAt: (index) => {
      const found = seek(index)

      return found === undefined
        ? undefined
        : found.segment.groups.get(found.segment.rows[found.at]?.item.id ?? '')
    },
    indexOf: (id) => {
      for (let s = 0; s < segments.length; s += 1) {
        const rows = segments[s]?.rows ?? NO_ROWS
        const start = offsets[s] ?? 0

        for (let i = 0; i < rows.length; i += 1) {
          if (rows[i]?.item.id === id) {
            return start + i
          }
        }
      }

      return -1
    },
    lastTurn,
    latestOwnMessage,
    processOf: (index) => {
      const found = seek(index)

      return found === undefined
        ? undefined
        : found.segment.marks.get(found.segment.rows[found.at]?.item.id ?? '')
    },
    replyAt: (index) => {
      const found = seek(index)

      return found === undefined ? undefined : found.segment.replies.get(found.at)
    },
    rowAt: (index) => {
      const found = seek(index)

      return found === undefined ? undefined : found.segment.rows[found.at]
    },
    sealAt: (index) => {
      const found = seek(index)

      return found === undefined ? undefined : found.segment.seals.get(found.at)
    },
    turns,
  }

  FEEDS.set(anchor, {
    active: state.active,
    live,
    opened,
    result,
    sealed: state.sealed,
    spans: state.spans,
    turns,
  })

  return result
}

/** 这一组里还在跑的那一条，倒着找：卡片只报最后一条的状态。 */
export function liveMemberOf(plan: ToolGroupPlan): FeedRow | undefined {
  for (let i = plan.members.length - 1; i >= 0; i -= 1) {
    const member = plan.members[i]

    if (member?.isInFlight === true) {
      return member
    }
  }

  return undefined
}
