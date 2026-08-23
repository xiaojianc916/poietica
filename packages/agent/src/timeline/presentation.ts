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
  readonly isOpen: boolean
  /** 这一轮此刻正在本进程里收帧。只有它为真，秒表才读本机时钟。 */
  readonly isLive: boolean
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

/** 旁白：既不是过程也不是回答，永不折叠。 */
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

/** 一条提问到下一条提问之间的回复操作；它不拥有运行封条。 */
interface Stanza {
  readonly replyId: TimelineItemId | undefined
  readonly replyText: string
}

/** 一次运行的全部派生。TurnPage 是缓存单位，也是封条的唯一所有者。 */
interface Segment {
  readonly span: TurnSpan | undefined
  readonly live: boolean
  readonly isOpen: boolean
  readonly rows: readonly FeedRow[]
  readonly groups: ReadonlyMap<string, ToolGroupPlan>
  readonly seals: ReadonlyMap<number, TurnSealPlan>
  readonly replies: ReadonlyMap<number, ReplyActionPlan>
  readonly staged: readonly Staged[]
  /** 首个提问之前那一段留下了什么：上一段末尾那一问要连着它一起算。 */
  readonly leading: Scan
  readonly ownMessage: string | null
}

interface Held {
  readonly sealed: readonly TurnPage[]
  readonly active: TurnPage
  readonly spans: readonly TurnSpan[]
  readonly chosen: ReadonlyMap<number, boolean>
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
 * 最终回复的起点；等于 until 表示这一轮一句都没说。
 *
 * 先认最后一条正文，再从它往回收拢连续的那一段。反过来（从末行往回收）会把「末尾挂着一条
 * 思考或一次收尾调用」判成「什么都没说」，于是已经写出来的回复也被收进封条 —— 那不是折叠
 * 过程，那是把答案藏了。旁白（报错、审批、提问）不打断这一段：它们既不是过程也不是回答。
 */
function replyFrom(rows: readonly FeedRow[], from: number, until: number): number {
  let last = -1

  for (let i = until - 1; i >= from; i -= 1) {
    if (rows[i]?.item.type === 'agent_text') {
      last = i

      break
    }
  }

  if (last < 0) {
    return until
  }

  for (let i = last - 1; i >= from; i -= 1) {
    const type = rows[i]?.item.type

    if (type === undefined || ASIDE.has(type)) {
      continue
    }

    if (type !== 'agent_text') {
      break
    }

    last = i
  }

  return last
}

/** 边界之前的过程行。人说的话与旁白永不折叠。 */
function foldFrom(rows: readonly FeedRow[], frontier: number): readonly number[] {
  const out: number[] = []

  for (let i = 0; i < frontier; i += 1) {
    const type = rows[i]?.item.type

    if (type === undefined || type === SAID || ASIDE.has(type)) {
      continue
    }

    out.push(i)
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
  live: boolean,
  isOpen: boolean,
): Segment {
  const all = rowsOf(page, live)
  const anchor = all.findIndex((row) => row.item.type === SAID)
  const bounds = boundsIn(all)
  const answer = replyFrom(all, 0, all.length)
  /*
   * 收进封条的是最终回复之前的全部过程，一次收干净。
   *
   * 此前这里还按「最后一问」再切一刀，于是一次运行里插过话就只有前半段进得去 —— 屏幕上
   * 是收了一半的封条。谁在等着回答由问题轨道自己算（下面那段 plans），运行边界不该跟它
   * 借判据。
   *
   * 一句都还没说的一轮分两种，判据是它还在不在跑：还在跑就是「话没说到」，整段都是过程，
   * 人因此仍收得起来；已经停了（断连、取消、崩在半路）就是「这些就是它交出来的东西」，
   * 那就没有过程可收 —— 屏幕上剩下什么，什么就是回复。
   */
  const process = foldFrom(all, answer === all.length && !live ? 0 : answer)
  const seal: TurnSealPlan | undefined =
    anchor < 0 || !bodyIn(all, 0, all.length)
      ? undefined
      : {
          endedAt: span?.endedAt,
          hasProcess: process.length > 0,
          isLive: live,
          isOpen,
          lastFrameAt: span?.lastFrameAt,
          startedAt: span?.startedAt,
          turn: page.turn,
        }
  const hidden = isOpen || seal === undefined ? new Set<number>() : new Set(process)

  /* 回复操作仍按提问划分；它与运行封条是两个不同的投影。 */
  const plans: Stanza[] = []

  for (let k = 0; k < bounds.length; k += 1) {
    const said = bounds[k] ?? -1
    const until = bounds[k + 1] ?? all.length
    const from = said + 1
    const stanzaAnswer = replyFrom(all, from, until)
    const alive = live && k === bounds.length - 1
    const tail = all[until - 1]
    const settled = !alive && !busyIn(all, from, until) && stanzaAnswer < until

    plans.push({
      replyId: settled && tail !== undefined ? tail.item.id : undefined,
      replyText: speechFrom(all, stanzaAnswer, until),
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
    isOpen,
    live,
    ownMessage,
    replies: replies.size === 0 ? NO_REPLIES : replies,
    rows: grouped.rows,
    seals: seals.size === 0 ? NO_SEALS : seals,
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
 * chosen 是人亲手为某一轮定下的开合；没有他的话，开合跟着这一轮跑不跑走。
 *
 * 跑着摊开 —— 过程正在发生，收起它就没有可看的东西了；停了收起 —— 这一轮交出了回复，
 * 过程于是降为脚注。这正是 primitives/disclosure 给整个界面定下的形状（运行中展开、落定
 * 收起、人点过以人为准），封条此前是全仓唯一一个例外：它永远默认摊开，于是「执行完自动
 * 折叠」从来没有发生过。
 */
export function selectPresentation(
  state: TimelineState,
  chosen: ReadonlyMap<number, boolean>,
): Presentation {
  const anchor = state.sealed[0] ?? state.active
  const live = selectIsBusy(state)
  const held = FEEDS.get(anchor)

  if (
    held !== undefined &&
    held.sealed === state.sealed &&
    held.active === state.active &&
    held.spans === state.spans &&
    held.chosen === chosen &&
    held.live === live
  ) {
    return held.result
  }

  const segments: Segment[] = []
  const offsets: number[] = []
  let count = 0

  for (const page of state.sealed) {
    const segment = segmentOf(
      page,
      spanOf(state.spans, page.turn),
      false,
      chosen.get(page.turn) ?? false,
    )

    segments.push(segment)
    offsets.push(count)
    count += segment.rows.length
  }

  const tail = segmentOf(
    state.active,
    spanOf(state.spans, state.active.turn),
    live,
    chosen.get(state.active.turn) ?? live,
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

  FEEDS.set(anchor, {
    active: state.active,
    chosen,
    live,
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
