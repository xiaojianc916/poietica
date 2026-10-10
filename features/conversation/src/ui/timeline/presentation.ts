import type { TranscriptUsage } from '@poietica/transcript'
import { lastAtOrBefore } from './ordered-lookup'
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

/** 运行负责收尾，用户消息只负责问题导航；撤销能力由协议投影提供。 */

/** 无开场条目时承载封条，不伪造聊天消息。 */
interface RunAnchor {
  readonly type: 'run_anchor'
  readonly id: string
  readonly turn: number
}

export interface FeedRow {
  readonly item: TimelineItem | RunAnchor
  readonly isStreamingTail: boolean
  readonly isInFlight: boolean
}

type ToolGroupKind = ToolCallTimelineItem['kind']

/**
 * 组头的说法：read 与 execute 合成一条「过程」，思考搭这条过程的顺风车
 * （它只在组头一闪而过，从不单独上屏）；其余类别按自己的 kind 各自成组。
 *
 * process 之外的那几档就是原来的 ToolKind。
 */
type ToolGroupFlavor = ToolGroupKind | 'process'

export interface ToolGroupPlan {
  /** 这一组自己的开合身份：成员的 id 归成员，组不借用其中任何一个。 */
  readonly id: string
  readonly kind: ToolGroupFlavor
  /** 按屏幕顺序的全部成员：过程组里混着思考，第一条是挂着这一组的那一行。 */
  readonly members: readonly FeedRow[]
  /** 会画进展开列表的工具成员；思考一个都不在里面。 */
  readonly tools: readonly FeedRow[]
}

/** 封条属于一次运行；身份直接使用 TurnPage 的权威段号。 */
export interface TurnSealPlan {
  readonly turn: number
  readonly durationMs: number | undefined
  readonly startedAt: number | undefined
  readonly endedAt: number | undefined
  /** 最近可用的官方时间，不充当终态终点。 */
  readonly lastFrameAt: number | undefined
  readonly hasProcess: boolean
  /** 生命周期来自当前运行自己的终态；时间戳只负责耗时。 */
  readonly isRunning: boolean
  readonly isOpen: boolean
}

export interface ReplyActionPlan {
  readonly text: string
  readonly undoCount: number | null
  readonly forkUnavailableReason: string | null
  /** 这一轮 agent 自己报的 token 用量；缺席不画。 */
  readonly usage?: TranscriptUsage
}

/** 屏幕要的一切，按下标问。 */
export interface Presentation {
  readonly count: number
  readonly latestOwnMessage: string | null
  readonly lastTurn: number | undefined
  readonly rowAt: (index: number) => FeedRow | undefined
  /** 这一条此刻在第几行。目录按 id 寻址，行号只在这里算。 */
  readonly rowOf: (id: TimelineItemId) => number | undefined
  /** 这一行属于哪一问：那条用户消息的 id。 */
  readonly turnIdAt: (index: number) => string | undefined
  readonly groupAt: (index: number) => ToolGroupPlan | undefined
  /** 该行之后的运行封条。 */
  readonly sealAt: (index: number) => TurnSealPlan | undefined
  readonly replyAt: (index: number) => ReplyActionPlan | undefined
}

/* 旁白不是助手正文；过程折叠按运行计算。 */
const ASIDE: ReadonlySet<FeedRow['item']['type']> = new Set(['error', 'link', 'permission', 'question'])
/* 字面量而不是 TimelineItem['type']：注解成联合后 === 不再收窄。 */
const SAID = 'user_message'

/** 两个以上成员才并组。任意一档里「单条工具加上一条思考」也够两个。 */
const LEAST = 2

/** 过程组的两类工具：read / execute 换着来也还是同一条过程。 */
const PROCESS: ReadonlySet<ToolGroupKind> = new Set(['execute', 'read'])

/** 行的分组归属：思考不算工具，它对每一档都是透明成员。 */
type RunFlavor = ToolGroupFlavor | 'thought'

function runFlavorOf(item: FeedRow['item']): RunFlavor | undefined {
  if (item.type === 'agent_thought') {
    return 'thought'
  }

  if (item.type !== 'tool_call') {
    return undefined
  }

  return PROCESS.has(item.kind) ? 'process' : item.kind
}

const NO_GROUPS: ReadonlyMap<string, ToolGroupPlan> = new Map()
const NO_SEALS: ReadonlyMap<number, TurnSealPlan> = new Map()
const NO_REPLIES: ReadonlyMap<number, ReplyActionPlan> = new Map()

const ROWS = new WeakMap<TimelineItem, FeedRow>()
const SEGMENTS = new WeakMap<TurnPage, Segment>()
const PREFIX = new WeakMap<readonly TurnPage[], Prefix>()
const PREFIX_ROWS = new WeakMap<Prefix, ReadonlyMap<string, number>>()
const FEEDS = new WeakMap<TimelineState, Held>()

/** 一问的落点。行号相对本段。 */
interface TurnAt {
  readonly row: number
  readonly id: string
}

/** 一次运行的全部派生。TurnPage 是缓存单位，也是封条的唯一所有者。 */
interface Segment {
  readonly span: TurnSpan | undefined
  /** 来自本运行的官方生命周期，不受下一条排队消息影响。 */
  readonly running: boolean
  /** 人亲手定过的终止后开合；运行中不读取。 */
  readonly picked: boolean | undefined
  readonly rows: readonly FeedRow[]
  readonly groups: ReadonlyMap<string, ToolGroupPlan>
  readonly seals: ReadonlyMap<number, TurnSealPlan>
  readonly replies: ReadonlyMap<number, ReplyActionPlan>
  /** 段内每一问的落点，升序。 */
  readonly said: readonly TurnAt[]
  /** 条目 id -> 段内行号。封条落位与目录寻址共用这一份。 */
  readonly where: ReadonlyMap<string, number>
  readonly ownMessage: string | null
}

/** 一份状态的投影。state 相同则段、轮、生命周期全都相同，只剩人选的开合要比。 */
interface Held {
  readonly chosen: ReadonlyMap<number, boolean>
  readonly result: Presentation
}

/** 已封口那一段的派生。sealed 只在换段时被替换，所以它跨帧按引用共享。 */
interface Prefix {
  readonly chosen: ReadonlyMap<number, boolean>
  /** 末段的 span：唯一还可能被改写的那一条，命中时按引用复核。 */
  readonly tailSpan: TurnSpan | undefined
  readonly segments: readonly Segment[]
  readonly offsets: readonly number[]
  readonly precedingTurnIds: readonly (string | undefined)[]
  readonly count: number
  readonly latestOwnMessage: string | null
  readonly lastTurn: number | undefined
  readonly lastTurnId: string | undefined
}

function toRow(item: TimelineItem, isStreamingTail: boolean, isInFlight: boolean): FeedRow {
  const held = ROWS.get(item)

  if (held !== undefined && held.isStreamingTail === isStreamingTail && held.isInFlight === isInFlight) {
    return held
  }

  const row: FeedRow = { isInFlight, isStreamingTail, item }

  ROWS.set(item, row)

  return row
}

/* 还在动吗。工具调用看终态，断线看接回来了没有 —— 一个判据两种条目，所以
   一轮死掉时两者的光同时停。 */
function inFlight(item: TimelineItem): boolean {
  if (item.type === 'link') {
    return item.link.state === 'retrying'
  }

  return item.type === 'tool_call' && !isTerminal(item.status)
}

function rowsOf(page: TurnPage, live: boolean): readonly FeedRow[] {
  const rows: FeedRow[] = []

  for (const item of page.items) {
    if (isRenderable(item)) {
      rows.push(toRow(item, false, live && inFlight(item)))
    }
  }

  if (page.run !== undefined && rows[0]?.item.type !== 'user_message') {
    rows.unshift({
      item: { type: 'run_anchor', id: `run-anchor:${page.turn}`, turn: page.turn },
      isStreamingTail: false,
      isInFlight: false,
    })
  }
  const tail = rows.at(-1)

  const type = tail?.item.type

  if (live && tail !== undefined && (type === 'agent_text' || type === 'agent_thought')) {
    rows[rows.length - 1] = toRow(tail.item, true, tail.isInFlight)
  }

  return rows
}

/** 用户消息只服务问题导航，不定义运行或撤销边界。 */
function saidIn(rows: readonly FeedRow[]): readonly number[] {
  const said: number[] = []

  for (let i = 0; i < rows.length; i += 1) {
    if (rows[i]?.item.type === SAID) {
      said.push(i)
    }
  }

  return said
}

/** 只认末尾正文；不能越过工具或思考尾巴倒找答案。 */
function answerStart(rows: readonly FeedRow[], from: number, until: number): number | undefined {
  let tail = until - 1
  while (tail >= from) {
    const type = rows[tail]?.item.type
    if (type === undefined || !ASIDE.has(type)) {
      break
    }
    tail -= 1
  }
  if (rows[tail]?.item.type !== 'agent_text') {
    return undefined
  }
  while (tail >= from && rows[tail]?.item.type === 'agent_text') {
    tail -= 1
  }
  return tail + 1
}

/** 输入、运行锚点与诊断保留可见，其余前缀是过程。 */
function foldFrom(rows: readonly FeedRow[], frontier: number): readonly number[] {
  const out: number[] = []

  for (let i = 0; i < frontier; i += 1) {
    const type = rows[i]?.item.type

    if (type === undefined || type === SAID || type === 'run_anchor' || ASIDE.has(type)) {
      continue
    }

    out.push(i)
  }

  return out
}

/** 从 rows 中剔除 sorted（升序下标）指定的行，游标归并，无 Set 分配。 */
function omitSorted(rows: readonly FeedRow[], sorted: readonly number[]): readonly FeedRow[] {
  const out: FeedRow[] = []
  let cursor = 0

  for (let i = 0; i < rows.length; i += 1) {
    if (cursor < sorted.length && sorted[cursor] === i) {
      cursor += 1
      continue
    }
    const row = rows[i]
    if (row !== undefined) {
      out.push(row)
    }
  }

  return out
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

/**
 * 一行能并进这一组吗。
 *
 * 思考对每一档都是透明的：read / execute 的过程收它，edit / fetch / search … 也收它 ——
 * 「想了一会儿」不是断点，它只借组头一闪，从不占成员列表。真正决定分组的还是工具自己：
 * 同一档相邻（中间的思考不算）就连成一条，换档才断。
 */
function continuesGroup(next: FeedRow['item'], flavor: RunFlavor): boolean {
  const nextFlavor = runFlavorOf(next)

  if (nextFlavor === undefined) {
    return false
  }

  if (nextFlavor === 'thought' || flavor === 'thought') {
    return true
  }

  return flavor === 'process' ? nextFlavor === 'process' : nextFlavor === flavor
}

/**
 * 从 start 那条开始，同轮同过程一直并到哪一行为止（不含）。
 *
 * 一组由思考打头时，第一件工具负责定档，之后的工具照这一档比 —— 「想一会儿再改、
 * 改完接着想」是同一条，想完却换了另一档工具则从这里断开。
 */
function runEnd(rows: readonly FeedRow[], start: number, flavor: RunFlavor, turn: number): number {
  let held = flavor
  let end = start + 1

  while (end < rows.length) {
    const next = rows[end]?.item

    if (next === undefined || next.turn !== turn || !continuesGroup(next, held)) {
      break
    }

    if (held === 'thought') {
      const adopted = runFlavorOf(next)

      if (adopted !== undefined && adopted !== 'thought') {
        held = adopted
      }
    }

    end += 1
  }

  return end
}

/** 一组工具的档位：read / execute 合成一条过程，其余照各自的 kind。 */
function flavorOfTools(tools: readonly FeedRow[]): ToolGroupFlavor {
  const head = tools[0]?.item

  return head?.type === 'tool_call' && !PROCESS.has(head.kind) ? head.kind : 'process'
}

function groupIn(rows: readonly FeedRow[]): {
  readonly rows: readonly FeedRow[]
  readonly groups: ReadonlyMap<string, ToolGroupPlan>
} {
  let kept: FeedRow[] | undefined
  let groups: Map<string, ToolGroupPlan> | undefined
  let cursor = 0

  /*
   * 到「第一处改动」为止的副本。这条投影每帧都跑，一行都没动过时交回原数组 ——
   * 没并组没丢行时不该凭空多一份复制。
   */
  const materialize = (upTo: number): FeedRow[] => {
    kept ??= rows.slice(0, upTo)

    return kept
  }

  while (cursor < rows.length) {
    const row = rows[cursor]

    if (row === undefined) {
      cursor += 1

      continue
    }

    const start = cursor
    const flavor = runFlavorOf(row.item)

    if (flavor === undefined) {
      kept?.push(row)
      cursor += 1

      continue
    }

    const end = runEnd(rows, cursor, flavor, row.item.turn)

    const members = rows.slice(cursor, end)
    const tools = members.filter((member) => member.item.type === 'tool_call')

    /*
     * 一整段纯思考：还在流才留一枚组头（就是它那一闪），流完整段消失 ——
     * 既不留行，也不进任何组内列表。
     */
    if (tools.length === 0) {
      if (members.some((member) => member.isStreamingTail)) {
        materialize(start).push(row)
        groups ??= new Map()
        groups.set(row.item.id, { id: `group:${row.item.id}`, kind: 'process', members, tools })
      } else {
        /* 落定的思考整段丢掉：为了把它从结果里剔出去，前面那份前缀必须真的复制出来。 */
        materialize(start)
      }

      cursor = end

      continue
    }

    /* 孤零零一条工具还是单行；旁边陪了一条思考就是一组（单条 read + 一条思考算组）。 */
    if (members.length < LEAST) {
      kept?.push(row)
      cursor = end

      continue
    }

    materialize(start).push(row)
    groups ??= new Map()
    groups.set(row.item.id, {
      id: `group:${row.item.id}`,
      kind: flavorOfTools(tools),
      members,
      tools,
    })
    cursor = end
  }

  return kept === undefined ? { groups: NO_GROUPS, rows } : { groups: groups ?? NO_GROUPS, rows: kept }
}

/** 段内每一问的落点。升序由 saidIn 保证。 */
function saidAt(rows: readonly FeedRow[]): readonly TurnAt[] {
  const marks: TurnAt[] = []

  for (const row of saidIn(rows)) {
    const id = rows[row]?.item.id

    if (id !== undefined) {
      marks.push({ id, row })
    }
  }

  return marks
}

/** 不晚于这一行的最后一问。段内升序，二分见 ordered-lookup。 */
function lastSaid(said: readonly TurnAt[], row: number): TurnAt | undefined {
  const at = lastAtOrBefore(said, (mark) => mark.row, row)

  return at === -1 ? undefined : said[at]
}

/** 可见行的行号索引：封条与回复操作都按它落位。 */
function placesIn(rows: readonly FeedRow[]): ReadonlyMap<string, number> {
  const where = new Map<string, number>()

  for (let i = 0; i < rows.length; i += 1) {
    const id = rows[i]?.item.id

    if (id !== undefined) {
      where.set(id, i)
    }
  }

  return where
}

/** 操作属于运行尾部，不属于某个正文节点。 */
function repliesIn(
  text: string,
  rows: readonly FeedRow[],
  run: TurnPage['run'],
  usage: TranscriptUsage | undefined,
): ReadonlyMap<number, ReplyActionPlan> {
  if (run?.settled !== true || text.length === 0 || rows.length === 0) {
    return NO_REPLIES
  }
  return new Map([
    [
      rows.length - 1,
      {
        text,
        undoCount: run.undoCount,
        forkUnavailableReason: run.forkUnavailableReason,
        ...(usage === undefined ? {} : { usage }),
      },
    ],
  ])
}

/** 运行事实拥有封条，计时与可折叠内容不决定准入。 */
function sealOf(
  page: TurnPage,
  span: TurnSpan | undefined,
  running: boolean,
  isOpen: boolean,
  hasProcess: boolean,
): TurnSealPlan | undefined {
  if (page.run === undefined) {
    return undefined
  }
  return {
    durationMs: span?.durationMs,
    endedAt: span?.endedAt,
    hasProcess,
    isOpen,
    isRunning: running,
    lastFrameAt: span?.lastFrameAt,
    startedAt: span?.startedAt,
    turn: page.turn,
  }
}

function buildSegment(
  page: TurnPage,
  span: TurnSpan | undefined,
  running: boolean,
  picked: boolean | undefined,
): Segment {
  const all = rowsOf(page, running)
  const isOpen = running || (picked ?? false)
  const answer = answerStart(all, 0, all.length)
  const process = foldFrom(all, answer ?? all.length)
  const seal = sealOf(page, span, running, isOpen, process.length > 0)
  const visible = isOpen || seal === undefined || process.length === 0 ? all : omitSorted(all, process)
  const grouped = groupIn(visible)
  const where = placesIn(grouped.rows)
  const first = grouped.rows[0]
  const sealAt = first === undefined ? undefined : where.get(first.item.id)
  const seals = seal === undefined || sealAt === undefined ? NO_SEALS : new Map<number, TurnSealPlan>([[sealAt, seal]])

  let ownMessage: string | null = null

  for (const row of grouped.rows) {
    if (row.item.type === SAID) {
      ownMessage = row.item.id
    }
  }

  return {
    groups: grouped.groups,
    ownMessage,
    picked,
    replies:
      page.run?.settled === true && grouped.rows.length > 0
        ? repliesIn(speechFrom(all, answer ?? 0, all.length), grouped.rows, page.run, page.usage)
        : NO_REPLIES,
    rows: grouped.rows,
    running,
    said: saidAt(grouped.rows),
    seals,
    span,
    where,
  }
}

function segmentOf(page: TurnPage, span: TurnSpan | undefined, running: boolean, picked: boolean | undefined): Segment {
  const held = SEGMENTS.get(page)

  if (held !== undefined && held.span === span && held.running === running && held.picked === picked) {
    return held
  }

  const built = buildSegment(page, span, running, picked)

  SEGMENTS.set(page, built)

  return built
}

/** spans 按官方运行序号有序。 */
function spanOf(spans: readonly TurnSpan[], turn: number): TurnSpan | undefined {
  let low = 0
  let high = spans.length - 1

  while (low <= high) {
    const mid = (low + high) >> 1
    const found = spans[mid]

    if (found === undefined || found.turn === turn) {
      return found
    }

    if (found.turn < turn) {
      low = mid + 1
    } else {
      high = mid - 1
    }
  }

  return undefined
}

/**
 * 已封口那一段的派生，一次算好跨帧用。
 *
 * sealed 段封口之后不再改写，它们的 span 也不再改写 —— 只有末段那一条还可能
 * 被收口，所以命中时复核它。
 */
function prefixOf(state: TimelineState, chosen: ReadonlyMap<number, boolean>): Prefix {
  const sealed = state.sealed
  const last = sealed.at(-1)
  const tailSpan = last === undefined ? undefined : spanOf(state.spans, last.turn)
  const kept = PREFIX.get(sealed)
  if (kept !== undefined && kept.chosen === chosen && kept.tailSpan === tailSpan) {
    return kept
  }

  const segments: Segment[] = []
  const offsets: number[] = []
  const precedingTurnIds: (string | undefined)[] = []
  let count = 0
  let latestOwnMessage: string | null = null
  let lastTurn: number | undefined
  let lastTurnId: string | undefined

  for (const page of sealed) {
    const segment = segmentOf(page, spanOf(state.spans, page.turn), page.run?.settled === false, chosen.get(page.turn))
    segments.push(segment)
    offsets.push(count)
    precedingTurnIds.push(lastTurnId)
    count += segment.rows.length
    latestOwnMessage = segment.ownMessage ?? latestOwnMessage
    lastTurn = segment.rows.at(-1)?.item.turn ?? lastTurn
    lastTurnId = segment.said.at(-1)?.id ?? lastTurnId
  }

  const built: Prefix = {
    chosen,
    count,
    lastTurn,
    lastTurnId,
    latestOwnMessage,
    offsets,
    precedingTurnIds,
    segments,
    tailSpan,
  }
  PREFIX.set(sealed, built)
  return built
}

function prefixLocations(prefix: Prefix): ReadonlyMap<string, number> {
  const kept = PREFIX_ROWS.get(prefix)
  if (kept !== undefined) {
    return kept
  }

  const rows = new Map<string, number>()
  for (let index = 0; index < prefix.segments.length; index += 1) {
    const segment = prefix.segments[index]
    const offset = prefix.offsets[index]
    if (segment === undefined || offset === undefined) {
      continue
    }
    for (const [id, at] of segment.where) {
      rows.set(id, offset + at)
    }
  }
  PREFIX_ROWS.set(prefix, rows)
  return rows
}

/**
 * 运行中无条件展开；终止后才读取用户选择。生命周期来自状态机，span 只装饰耗时。
 */
export function selectPresentation(state: TimelineState, chosen: ReadonlyMap<number, boolean>): Presentation {
  const held = FEEDS.get(state)
  const running = state.active.run?.settled === false
  if (held !== undefined && held.chosen === chosen) {
    return held.result
  }

  const prefix = prefixOf(state, chosen)
  const activeSpan = spanOf(state.spans, state.active.turn)
  const tail = segmentOf(state.active, activeSpan, running, chosen.get(state.active.turn))
  const count = prefix.count + tail.rows.length

  const locate = (index: number) => {
    if (index < 0 || index >= count) {
      return undefined
    }
    if (index >= prefix.count) {
      return {
        at: index - prefix.count,
        precedingTurnId: prefix.lastTurnId,
        segment: tail,
      }
    }

    let low = 0
    let high = prefix.offsets.length - 1
    while (low < high) {
      const mid = (low + high + 1) >> 1
      if ((prefix.offsets[mid] ?? 0) <= index) {
        low = mid
      } else {
        high = mid - 1
      }
    }
    const segment = prefix.segments[low]
    const start = prefix.offsets[low]
    if (segment === undefined || start === undefined) {
      return undefined
    }
    return {
      at: index - start,
      precedingTurnId: prefix.precedingTurnIds[low],
      segment,
    }
  }

  let soughtIndex = -1
  let sought = locate(-1)
  const seek = (index: number): ReturnType<typeof locate> => {
    if (index === soughtIndex) {
      return sought
    }

    soughtIndex = index
    sought = locate(index)
    return sought
  }

  const result: Presentation = {
    count,
    latestOwnMessage: tail.ownMessage ?? prefix.latestOwnMessage,
    lastTurn: tail.rows.at(-1)?.item.turn ?? prefix.lastTurn,
    groupAt: (index) => {
      const found = seek(index)
      return found?.segment.groups.get(found.segment.rows[found.at]?.item.id ?? '')
    },
    replyAt: (index) => {
      const found = seek(index)
      return found?.segment.replies.get(found.at)
    },
    rowAt: (index) => {
      const found = seek(index)
      return found?.segment.rows[found.at]
    },
    rowOf: (id) => {
      const active = tail.where.get(id)
      return active === undefined ? prefixLocations(prefix).get(id) : prefix.count + active
    },
    sealAt: (index) => {
      const found = seek(index)
      return found?.segment.seals.get(found.at)
    },
    turnIdAt: (index) => {
      const found = seek(index)
      if (found === undefined) {
        return undefined
      }
      return lastSaid(found.segment.said, found.at)?.id ?? found.precedingTurnId
    },
  }

  FEEDS.set(state, { chosen, result })
  return result
}

/**
 * 这一组里还在动的那一条，倒着找：卡片只报最后一条的状态。
 *
 * 工具看终态，思考看是不是还挂在流式尾巴上 —— 思考没有终态可等，字还在来就是还在。
 */
export function liveMemberOf(plan: ToolGroupPlan): FeedRow | undefined {
  return plan.members.findLast((member) => member.isInFlight === true || member.isStreamingTail === true)
}
