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
 * 段（TurnPage）封口之后不再改写，所以一帧只重算活动的那一段，代价与对话长度无关。
 * 行不拼成一个大数组 —— 虚拟器本来就按下标问（count / getItemKey / estimateSize
 * 都是下标函数），拼出来的那一份只会被它按下标读回去。
 *
 * 折叠、并组、封条、回复操作、轮次索引都在这里算完：同一件事一条路径。
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

export interface TurnSealPlan {
  readonly turn: number
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
  /** 瞬态区：还在跑的那一轮里被折走的过程，随轮次一起收走。 */
  readonly live: readonly FeedRow[]
  readonly latestOwnMessage: string | null
  readonly lastTurn: number | undefined
  readonly rowAt: (index: number) => FeedRow | undefined
  readonly groupAt: (index: number) => ToolGroupPlan | undefined
  readonly sealAt: (index: number) => TurnSealPlan | undefined
  readonly replyAt: (index: number) => ReplyActionPlan | undefined
  readonly isProcessRow: (index: number) => boolean
  readonly indexOf: (id: string) => number
  readonly liveGroupOf: (id: string) => ToolGroupPlan | undefined
}

/** 旁白：既不是过程也不是回答，倒扫时跨过，永不折叠。 */
const ASIDE: ReadonlySet<TimelineItem['type']> = new Set(['error', 'permission', 'question'])
/* 字面量而不是 TimelineItem['type']：注解成联合后 === 不再收窄，判别就白做了。 */
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
const NO_GROUPS: ReadonlyMap<string, ToolGroupPlan> = new Map()
const NO_MARKS: ReadonlySet<string> = new Set()

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

/** 一段的全部派生。段是缓存单位，也是重算单位。 */
interface Segment {
  readonly span: TurnSpan | undefined
  readonly live: boolean
  readonly isOpen: boolean
  readonly rows: readonly FeedRow[]
  readonly groups: ReadonlyMap<string, ToolGroupPlan>
  readonly sealAt: number
  readonly seal: TurnSealPlan | undefined
  readonly replyAt: number
  readonly reply: ReplyActionPlan | undefined
  readonly marks: ReadonlySet<string>
  readonly liveRows: readonly FeedRow[]
  readonly liveGroups: ReadonlyMap<string, ToolGroupPlan>
  readonly staged: readonly Staged[]
  /** 首个提问之前那一段留下了什么：上一段末尾那一问要连着它一起算。 */
  readonly leading: Scan
  readonly ownMessage: string | null
}

interface Held {
  readonly sealed: readonly TurnPage[]
  readonly active: TurnPage
  readonly spans: readonly TurnSpan[]
  readonly opened: ReadonlySet<number>
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

/** 最后一段连续回答的起点；-1 表示这一轮还没开口。 */
function answerAt(rows: readonly FeedRow[]): number {
  let found = -1

  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const row = rows[i]

    if (row === undefined || ASIDE.has(row.item.type)) {
      continue
    }

    if (row.item.type === 'agent_text') {
      found = i

      continue
    }

    if (found >= 0) {
      break
    }
  }

  return found
}

function processIn(rows: readonly FeedRow[], answer: number, running: boolean): readonly number[] {
  const out: number[] = []

  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i]

    if (row === undefined || row.item.type === SAID || ASIDE.has(row.item.type)) {
      continue
    }

    if (i < answer || (running && row.item.type !== 'agent_text')) {
      out.push(i)
    }
  }

  return out
}

function liveIn(
  rows: readonly FeedRow[],
  folded: readonly number[],
  answer: number,
): readonly FeedRow[] {
  const out: FeedRow[] = []

  for (const one of folded) {
    const row = rows[one]

    if (row !== undefined && one > answer && row.item.type !== 'agent_text') {
      out.push(row)
    }
  }

  return out.length === 0 ? NO_ROWS : out
}

function speechFrom(rows: readonly FeedRow[], answer: number): string {
  const said: string[] = []

  for (let i = Math.max(answer, 0); i < rows.length; i += 1) {
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
  isOpen: boolean,
): Segment {
  const all = rowsOf(page, live)
  const answer = answerAt(all)
  const running = span?.startedAt !== undefined && span.endedAt === undefined
  const process = span === undefined ? [] : processIn(all, answer, running)
  const said = all.some((row) => row.item.type === SAID)
  const seal: TurnSealPlan | undefined =
    !said || span?.firstFrameAt === undefined
      ? undefined
      : {
          endedAt: span.endedAt,
          hasProcess: process.length > 0,
          isOpen,
          startedAt: span.firstFrameAt,
          turn: page.turn,
        }

  const folded = seal === undefined ? [] : process
  const hidden = isOpen ? new Set<number>() : new Set(folded)
  const visible = hidden.size === 0 ? all : all.filter((_, one) => !hidden.has(one))
  const grouped = groupIn(visible)
  const transient =
    seal !== undefined && running && !isOpen
      ? groupIn(liveIn(all, folded, answer))
      : { groups: NO_GROUPS, rows: NO_ROWS }

  /* 封条挂在这一轮第一条不是本人发言的可见行上：耗时属于回答，不属于提问。 */
  const sealAt = seal === undefined ? -1 : grouped.rows.findIndex((row) => row.item.type !== SAID)
  const streaming = grouped.rows.some((row) => row.isStreamingTail || row.isInFlight)
  const replyAt = running || streaming ? -1 : grouped.rows.length - 1
  const marks =
    seal === undefined
      ? NO_MARKS
      : new Set(
          process.map((one) => all[one]?.item.id).filter((id): id is string => id !== undefined),
        )

  let ownMessage: string | null = null

  for (const row of grouped.rows) {
    if (row.item.type === SAID) {
      ownMessage = row.item.id
    }
  }

  return {
    ...stageIn(grouped.rows),
    groups: grouped.groups,
    isOpen,
    live,
    liveGroups: transient.groups,
    liveRows: transient.rows,
    marks,
    ownMessage,
    reply: replyAt < 0 ? undefined : { text: speechFrom(grouped.rows, answerAt(grouped.rows)) },
    replyAt,
    rows: grouped.rows,
    seal: sealAt < 0 ? undefined : seal,
    sealAt,
    span,
  }
}

function segmentOf(
  page: TurnPage,
  span: TurnSpan | undefined,
  live: boolean,
  isOpen: boolean,
): Segment {
  const held = SEGMENTS.get(page)

  if (held !== undefined && held.span === span && held.live === live && held.isOpen === isOpen) {
    return held
  }

  const built = buildSegment(page, span, live, isOpen)

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

/** 各段的提问摊平成一条线；段尾那一问的应答可能落在后面的段里，顺路接上。 */
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
  opened: ReadonlySet<number>,
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
    const segment = segmentOf(page, spanOf(state.spans, page.turn), false, opened.has(page.turn))

    segments.push(segment)
    offsets.push(count)
    count += segment.rows.length
  }

  const tail = segmentOf(
    state.active,
    spanOf(state.spans, state.active.turn),
    live,
    opened.has(state.active.turn),
  )

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
    isProcessRow: (index) => {
      const found = seek(index)

      return found === undefined
        ? false
        : found.segment.marks.has(found.segment.rows[found.at]?.item.id ?? '')
    },
    lastTurn,
    latestOwnMessage,
    live: tail.liveRows,
    liveGroupOf: (id) => tail.liveGroups.get(id),
    replyAt: (index) => {
      const found = seek(index)

      return found?.at === found?.segment.replyAt ? found?.segment.reply : undefined
    },
    rowAt: (index) => seek(index)?.segment.rows[seek(index)?.at ?? -1],
    sealAt: (index) => {
      const found = seek(index)

      return found?.at === found?.segment.sealAt ? found?.segment.seal : undefined
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
