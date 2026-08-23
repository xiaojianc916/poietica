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
 * TurnPage 是一次运行的权威边界：封条与过程折叠只按它计算。问题轨道仍按用户消息计算，
 * 但消息不能反过来伪造运行边界；插话与排队提问因此不会多造封条。
 */

export interface FeedRow {
  readonly item: TimelineItem
  readonly isStreamingTail: boolean
  readonly isInFlight: boolean
}

export type ToolGroupKind = ToolCallTimelineItem['kind']

export interface ToolGroupPlan {
  readonly kind: ToolGroupKind
  /** 按屏幕顺序，第一条就是挂着这一组的那一行。 */
  readonly members: readonly FeedRow[]
}

/** 封条属于一次运行；身份直接使用 TurnPage 的权威段号。 */
export interface TurnSealPlan {
  readonly turn: number
  readonly startedAt: number | undefined
  readonly endedAt: number | undefined
  /** 运行中的耗时以它为终点，所以秒表不会超过实际收帧的跨度。 */
  readonly lastFrameAt: number | undefined
  readonly hasProcess: boolean
  /** 生命周期来自 TimelineState.status；时间戳只负责耗时。 */
  readonly isRunning: boolean
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
  /** 画在这一行之前的封条：一轮的封条挂在它第一行可见内容的前面。 */
  readonly sealAt: (index: number) => TurnSealPlan | undefined
  readonly replyAt: (index: number) => ReplyActionPlan | undefined
  readonly indexOf: (id: string) => number
}

/** 旁白不参与回复分段；有最终正文时仍随之前的过程一起折叠。 */
const ASIDE: ReadonlySet<TimelineItem['type']> = new Set(['error', 'permission', 'question'])
/* 字面量而不是 TimelineItem['type']：注解成联合后 === 不再收窄。 */
const SAID = 'user_message'
const PREVIEW = 300

/** 同类相邻才并组。类别表就是 ToolKind，这里不抄第二份。 */
const LEAST = 2

const NO_ROWS: readonly FeedRow[] = []
const NO_TURNS: readonly ConversationTurn[] = []
const NO_GROUPS: ReadonlyMap<string, ToolGroupPlan> = new Map()
const NO_SEALS: ReadonlyMap<number, TurnSealPlan> = new Map()
const NO_REPLIES: ReadonlyMap<number, ReplyActionPlan> = new Map()

const ROWS = new WeakMap<TimelineItem, FeedRow>()
const SEGMENTS = new WeakMap<TurnPage, Segment>()
const SPANS = new WeakMap<readonly TurnSpan[], ReadonlyMap<number, TurnSpan>>()
const TURN_OF = new WeakMap<FeedRow, ConversationTurn>()
const FEEDS = new WeakMap<TimelineState, Held>()

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

/** 一条提问到下一条提问之间的回复操作；它不拥有运行封条。 */
interface Stanza {
  readonly replyId: TimelineItemId | undefined
  readonly replyText: string
}

/** 一次运行的全部派生。TurnPage 是缓存单位，也是封条的唯一所有者。 */
interface Segment {
  readonly span: TurnSpan | undefined
  /** 这一轮是否仍允许接收内容，由 TimelineState.status 唯一决定。 */
  readonly running: boolean
  /** 人亲手定过的终止后开合；运行中不读取。 */
  readonly picked: boolean | undefined
  readonly rows: readonly FeedRow[]
  readonly groups: ReadonlyMap<string, ToolGroupPlan>
  readonly seals: ReadonlyMap<number, TurnSealPlan>
  readonly replies: ReadonlyMap<number, ReplyActionPlan>
  readonly staged: readonly Staged[]
  /** 首个提问之前那一段留下了什么：上一段末尾那一问要连着它一起算。 */
  readonly leading: Scan
  readonly ownMessage: string | null
}

/** 一份状态的投影。state 相同则段、轮、生命周期全都相同，只剩人选的开合要比。 */
interface Held {
  readonly chosen: ReadonlyMap<number, boolean>
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
  const type = tail?.item.type

  if (live && tail !== undefined && (type === 'agent_text' || type === 'agent_thought')) {
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

/**
 * 最终回复的起点：末尾那串相邻正文的第一条；这一轮没说过话就没有起点。
 *
 * 折叠边界与回复取值同问这一处，屏幕上留下的与复制出去的因此恒等。
 */
function answerStart(rows: readonly FeedRow[], from: number, until: number): number | undefined {
  let first: number | undefined

  for (let i = until - 1; i >= from; i -= 1) {
    if (rows[i]?.item.type !== 'agent_text') {
      if (first !== undefined) {
        break
      }

      continue
    }

    first = i
  }

  return first
}

/** 边界之前除用户消息外的全部内容。 */
function foldFrom(rows: readonly FeedRow[], frontier: number): readonly number[] {
  const out: number[] = []

  for (let i = 0; i < frontier; i += 1) {
    const type = rows[i]?.item.type

    if (type === undefined || type === SAID) {
      continue
    }

    out.push(i)
  }

  return out
}

/** 这一轮有没有正文；旁白不算正文。 */
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

    const kind = row.item.type === 'tool_call' ? row.item.kind : undefined

    if (kind === undefined) {
      kept?.push(row)
      cursor += 1

      continue
    }

    let end = cursor + 1

    while (end < rows.length) {
      const next = rows[end]?.item

      if (next?.type !== 'tool_call' || next.turn !== row.item.turn || next.kind !== kind) {
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
  running: boolean,
  picked: boolean | undefined,
): Segment {
  const all = rowsOf(page, running)
  const anchor = all.findIndex((row) => row.item.type === SAID)
  const bounds = boundsIn(all)
  /* 没有起点就没有过程：一句话都没说出来的一轮整段留在屏幕上，不折叠。 */
  const process = foldFrom(all, answerStart(all, 0, all.length) ?? 0)
  const isOpen = running || (picked ?? false)
  const hasBody = bodyIn(all, 0, all.length)
  const seal: TurnSealPlan | undefined =
    anchor < 0 || (!hasBody && span?.startedAt === undefined)
      ? undefined
      : {
          endedAt: span?.endedAt,
          hasProcess: process.length > 0,
          isOpen,
          isRunning: running,
          lastFrameAt: span?.lastFrameAt,
          startedAt: span?.startedAt,
          turn: page.turn,
        }
  const hidden = isOpen || seal === undefined ? new Set<number>() : new Set(process)

  /* 回复操作按提问划分跨度，起点仍问 answerStart：一个判据，两个读者。 */
  const plans: Stanza[] = []

  for (let k = 0; k < bounds.length; k += 1) {
    const said = bounds[k] ?? -1
    const until = bounds[k + 1] ?? all.length
    const from = said + 1
    const stanzaAnswer = answerStart(all, from, until)
    const alive = running && k === bounds.length - 1
    const tail = all[until - 1]
    const settled = !alive && !busyIn(all, from, until) && stanzaAnswer !== undefined

    plans.push({
      replyId: settled && tail !== undefined ? tail.item.id : undefined,
      replyText: stanzaAnswer === undefined ? '' : speechFrom(all, stanzaAnswer, until),
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
  const anchorId = anchor < 0 ? undefined : all[anchor]?.item.id
  const sealAt = anchorId === undefined ? undefined : where.get(anchorId)

  if (seal !== undefined && sealAt !== undefined) {
    seals.set(sealAt, seal)
  }

  const replies = new Map<number, ReplyActionPlan>()

  for (const plan of plans) {
    const replyAt = plan.replyId === undefined ? undefined : where.get(plan.replyId)

    if (replyAt !== undefined) {
      replies.set(replyAt, { text: plan.replyText })
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
    ownMessage,
    picked,
    replies: replies.size === 0 ? NO_REPLIES : replies,
    rows: grouped.rows,
    running,
    seals: seals.size === 0 ? NO_SEALS : seals,
    span,
  }
}

function segmentOf(
  page: TurnPage,
  span: TurnSpan | undefined,
  running: boolean,
  picked: boolean | undefined,
): Segment {
  const held = SEGMENTS.get(page)

  if (
    held !== undefined &&
    held.span === span &&
    held.running === running &&
    held.picked === picked
  ) {
    return held
  }

  const built = buildSegment(page, span, running, picked)

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

/**
 * 运行中无条件展开；终止后才读取用户选择。生命周期来自状态机，span 只装饰耗时。
 */
export function selectPresentation(
  state: TimelineState,
  chosen: ReadonlyMap<number, boolean>,
): Presentation {
  const held = FEEDS.get(state)
  const running = selectIsBusy(state)

  if (held !== undefined && held.chosen === chosen) {
    return held.result
  }

  const segments: Segment[] = []
  const offsets: number[] = []
  let count = 0

  for (const page of state.sealed) {
    const segment = segmentOf(page, spanOf(state.spans, page.turn), false, chosen.get(page.turn))

    segments.push(segment)
    offsets.push(count)
    count += segment.rows.length
  }

  const activeSpan = spanOf(state.spans, state.active.turn)
  const tail = segmentOf(state.active, activeSpan, running, chosen.get(state.active.turn))

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

  let places: Map<string, number> | undefined

  /* 行号表按需建一次：只有跳转与前插锚定问它，流式追加从不问。 */
  const placeOf = (id: string): number => {
    if (places === undefined) {
      places = new Map<string, number>()

      for (let s = 0; s < segments.length; s += 1) {
        const rows = segments[s]?.rows ?? NO_ROWS
        const start = offsets[s] ?? 0

        for (let i = 0; i < rows.length; i += 1) {
          const rowId = rows[i]?.item.id

          if (rowId !== undefined) {
            places.set(rowId, start + i)
          }
        }
      }
    }

    return places.get(id) ?? -1
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
    indexOf: placeOf,
    lastTurn,
    latestOwnMessage,
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

  FEEDS.set(state, { chosen, result, turns })

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
