import type { TranscriptUsage } from '@poietica/transcript'
import { lastAtOrBefore } from './ordered-lookup'
import { isRenderable } from './renderable'
import {
  isTerminal,
  type TimelineItem,
  type TimelineItemId,
  type TimelineState,
  type ToolCallTimelineItem,
  type TurnOutcome,
  type TurnPage,
  type TurnSpan,
} from './timeline-contract'
import { PROCESS_FAMILY, toolFamilyOf } from './tools/tool-family'

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

/** 阅读 / 搜索 / 运行命令合成一条「过程」，思考搭顺风车（只在组头一闪而过，从不单独上屏）；其余按族成组（tools/tool-family）。 */
type ToolGroupFlavor = ToolGroupKind | 'process'

export interface ToolGroupPlan {
  readonly id: string
  /** 过程组是 'process'，其余是打头那条工具的 kind（兜底措辞用）。 */
  readonly kind: ToolGroupFlavor
  /** 并组凭据（toolFamilyOf 的 key）：同 key 相邻才连成一组。 */
  readonly family: string
  readonly members: readonly FeedRow[]
  readonly tools: readonly FeedRow[]
}

export interface TurnSealPlan {
  readonly turn: number
  readonly outcome: TurnOutcome | undefined
  readonly durationMs: number | undefined
  readonly startedAt: number | undefined
  readonly endedAt: number | undefined
  readonly hasProcess: boolean
  /** 这一轮此刻是不是摊开的（在跑、被打断、出错，或人点开过）。 */
  readonly isOpen: boolean
  /** 能不能点着折叠（DSH 的 canCollapse：有过程、且不满足「永远摊开」）。 */
  readonly canCollapse: boolean
}

/**
 * 这一轮是不是**永远摊开**（DSH turnProcessAlwaysOpen）：被人叫停、自己坏了、或者中途有人插过话。
 * 三者都不接受折叠 —— 前两个要让人看见它停在哪、坏在哪；有插话的那一轮，那段过程里夹着人自己的话，
 * 折起来会把他的话一起藏掉。正在跑的那一轮压根没有封条（见 sealOf），所以不必在这里判。
 */
function pinnedOpen(outcome: TurnOutcome | undefined, interjected: boolean): boolean {
  return interjected || outcome === 'aborted' || outcome === 'error'
}

/**
 * 轮里有没有**中途插话**（DSH 的 hasInterleavedInput）：开场那句之后、这一轮已经在干活了，人又说了话。
 *
 * 判据是「人说的话出现在它的产出之后」：开场白与它那一条重复的帧都在产出之前，不算插话。
 * agent_text / agent_thought / tool_call 三者任一出现就说明这一轮已经在干活了。
 */
function interjectedIn(rows: readonly FeedRow[]): boolean {
  let worked = false

  for (const row of rows) {
    const type = row.item.type

    if (type === 'agent_text' || type === 'agent_thought' || type === 'tool_call') {
      worked = true
      continue
    }

    if (worked && type === 'user_message') {
      return true
    }
  }

  return false
}

export interface ReplyActionPlan {
  readonly text: string
  readonly keepTurns: number | null
  readonly forkUnavailableReason: string | null
  readonly usage?: TranscriptUsage
}

/**
 * 转录末尾那一行运行状态的判据（DSH RunningStatus 的挂载条件 + 分隔线条件）。
 *
 * `startedAt` 缺席时报不出时长，只报「深度求索中」。`divided` 说的是「它上面已经有不是
 * 我说话的东西」—— 直接跟在自己那句话后面时不画线，那一格本来就是「我说完了，它开始动」。
 */
export interface RunningPlan {
  readonly startedAt: number | undefined
  readonly divided: boolean
}

export interface Presentation {
  readonly count: number
  readonly latestOwnMessage: string | null
  readonly lastTurn: number | undefined
  readonly running: RunningPlan | undefined
  readonly rowAt: (index: number) => FeedRow | undefined
  readonly rowOf: (id: TimelineItemId) => number | undefined
  readonly turnIdAt: (index: number) => string | undefined
  readonly groupAt: (index: number) => ToolGroupPlan | undefined
  readonly sealAt: (index: number) => TurnSealPlan | undefined
  readonly replyAt: (index: number) => ReplyActionPlan | undefined
}

/* 旁白不是助手正文；过程折叠按运行计算。 */
const ASIDE: ReadonlySet<FeedRow['item']['type']> = new Set(['error', 'link', 'permission', 'question'])
/* 字面量而不是 TimelineItem['type']：注解成联合后 === 不再收窄。 */
const SAID = 'user_message'

/* 自己就是内容的工具（R-18 的 show_widget）：不并进过程组，轮次落定后也不折进「过程」里；失败的那次照常归过程。 */
const SHOWN_INLINE: ReadonlySet<string> = new Set(['show_widget'])

function isShownInline(item: FeedRow['item']): boolean {
  return item.type === 'tool_call' && item.status !== 'failed' && SHOWN_INLINE.has(item.invokedTool)
}

const LEAST = 2

/* 'thought' 不会与族 key 撞名：族 key 只有 process / 固定族名 / mcp:… / tool:…。 */
type RunFlavor = string

const THOUGHT = 'thought'

function runFlavorOf(item: FeedRow['item']): RunFlavor | undefined {
  if (item.type === 'agent_thought') {
    return THOUGHT
  }

  if (item.type !== 'tool_call' || isShownInline(item)) {
    return undefined
  }

  return toolFamilyOf(item).key
}

/*
 * 运行状态行只在**真在跑**时上屏（DSH 挂载 RunningStatus 的条件就是会话 running）。判据是这一轮
 * 有没有终局，而不是 status —— 停在「等待审批」上时这一轮还在跑，那一行该在。
 */
const NO_RUNNING: RunningPlan | undefined = undefined

const NO_GROUPS: ReadonlyMap<string, ToolGroupPlan> = new Map()
const NO_SEALS: ReadonlyMap<number, TurnSealPlan> = new Map()
const NO_REPLIES: ReadonlyMap<number, ReplyActionPlan> = new Map()

const ROWS = new WeakMap<TimelineItem, FeedRow>()
const SEGMENTS = new WeakMap<TurnPage, Segment>()
const PREFIX = new WeakMap<readonly TurnPage[], Prefix>()
const PREFIX_ROWS = new WeakMap<Prefix, ReadonlyMap<string, number>>()
const FEEDS = new WeakMap<TimelineState, Held>()

interface TurnAt {
  readonly row: number
  readonly id: string
}

/** 一次运行的全部派生。TurnPage 是缓存单位，也是封条的唯一所有者。 */
interface Segment {
  readonly span: TurnSpan | undefined
  readonly running: boolean
  readonly picked: boolean | undefined
  readonly rows: readonly FeedRow[]
  readonly groups: ReadonlyMap<string, ToolGroupPlan>
  readonly seals: ReadonlyMap<number, TurnSealPlan>
  readonly replies: ReadonlyMap<number, ReplyActionPlan>
  readonly said: readonly TurnAt[]
  readonly where: ReadonlyMap<string, number>
  readonly ownMessage: string | null
}

/** 一份状态的投影。state 相同则段、轮、生命周期全都相同，只剩人选的开合要比。 */
interface Held {
  readonly chosen: ReadonlyMap<number, boolean>
  readonly result: Presentation
}

interface Prefix {
  readonly chosen: ReadonlyMap<number, boolean>
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

/* 还在动吗。工具调用看终态，断线看接回来了没有 —— 一个判据两种条目，所以一轮死掉时两者的光同时停。 */
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

/** 输入、运行锚点、诊断与组件保留可见，其余前缀是过程。 */
function foldFrom(rows: readonly FeedRow[], frontier: number): readonly number[] {
  const out: number[] = []

  for (let i = 0; i < frontier; i += 1) {
    const item = rows[i]?.item

    if (
      item === undefined ||
      item.type === SAID ||
      item.type === 'run_anchor' ||
      ASIDE.has(item.type) ||
      isShownInline(item)
    ) {
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

/** 一行能并进这一组吗。思考对每一族都是透明的（「想了一会儿」不是断点，它只借组头一闪）；真正决定分组的是工具自己：同一族相邻就连成一条，换族才断。 */
function continuesGroup(next: FeedRow['item'], flavor: RunFlavor): boolean {
  const nextFlavor = runFlavorOf(next)

  if (nextFlavor === undefined) {
    return false
  }

  if (nextFlavor === THOUGHT || flavor === THOUGHT) {
    return true
  }

  return nextFlavor === flavor
}

/** 从 start 那条开始，同轮同过程一直并到哪一行为止（不含）。一组由思考打头时，第一件工具负责定档，之后的工具照这一档比。 */
function runEnd(rows: readonly FeedRow[], start: number, flavor: RunFlavor, turn: number): number {
  let held = flavor
  let end = start + 1

  while (end < rows.length) {
    const next = rows[end]?.item

    if (next === undefined || next.turn !== turn || !continuesGroup(next, held)) {
      break
    }

    if (held === THOUGHT) {
      const adopted = runFlavorOf(next)

      if (adopted !== undefined && adopted !== THOUGHT) {
        held = adopted
      }
    }

    end += 1
  }

  return end
}

function planOfTools(tools: readonly FeedRow[]): Pick<ToolGroupPlan, 'family' | 'kind'> {
  const head = tools[0]?.item

  if (head?.type !== 'tool_call') {
    return { family: PROCESS_FAMILY, kind: 'process' }
  }

  const family = toolFamilyOf(head).key

  return { family, kind: family === PROCESS_FAMILY ? 'process' : head.kind }
}

function groupIn(rows: readonly FeedRow[]): {
  readonly rows: readonly FeedRow[]
  readonly groups: ReadonlyMap<string, ToolGroupPlan>
} {
  let kept: FeedRow[] | undefined
  let groups: Map<string, ToolGroupPlan> | undefined
  let cursor = 0

  /* 到「第一处改动」为止的副本。这条投影每帧都跑，一行都没动过时交回原数组 —— 没并组没丢行时不该凭空多一份复制。 */
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

    /* 一整段纯思考：还在流才留一枚组头（就是它那一闪），流完整段消失 —— 既不留行，也不进任何组内列表。 */
    if (tools.length === 0) {
      if (members.some((member) => member.isStreamingTail)) {
        materialize(start).push(row)
        groups ??= new Map()
        groups.set(row.item.id, { id: `group:${row.item.id}`, family: PROCESS_FAMILY, kind: 'process', members, tools })
      } else {
        /* 落定的思考整段丢掉：为了把它从结果里剔出去，前面那份前缀必须真的复制出来。 */
        materialize(start)
      }

      cursor = end

      continue
    }

    /*
     * 成组只数工具，不数思考：思考从不上屏，「一条工具 + 一段看不见的思考」画成组只会多出一个点开还是那一条的箭头。
     * 唯一的例外是思考正在流：组头要借给它那一闪（落定后这一组退回单行，组头与单行同是一行高，不跳）。
     */
    const thinking = members.some((member) => member.isStreamingTail && member.item.type === 'agent_thought')

    if (tools.length < LEAST && !thinking) {
      if (members.length === 1) {
        kept?.push(row)
      } else {
        /* 落定的思考一并丢掉，只留那条工具。 */
        materialize(start).push(...tools)
      }

      cursor = end

      continue
    }

    materialize(start).push(row)
    groups ??= new Map()
    groups.set(row.item.id, {
      id: `group:${row.item.id}`,
      ...planOfTools(tools),
      members,
      tools,
    })
    cursor = end
  }

  return kept === undefined ? { groups: NO_GROUPS, rows } : { groups: groups ?? NO_GROUPS, rows: kept }
}

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

function lastSaid(said: readonly TurnAt[], row: number): TurnAt | undefined {
  const at = lastAtOrBefore(said, (mark) => mark.row, row)

  return at === -1 ? undefined : said[at]
}

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
        keepTurns: run.keepTurns,
        forkUnavailableReason: run.forkUnavailableReason,
        ...(usage === undefined ? {} : { usage }),
      },
    ],
  ])
}

function sealOf(
  page: TurnPage,
  span: TurnSpan | undefined,
  running: boolean,
  isOpen: boolean,
  hasProcess: boolean,
  interjected: boolean,
): TurnSealPlan | undefined {
  /*
   * 这一轮还没结束就没有封条（DSH：turn.status !== 'closed' 就返回 null）。在跑的那一句由转录末尾的
   * 运行状态行说 —— 两处都报「正在处理」是两种说法说同一件事，而且封条这一格报不出「它还在不在动」。
   */
  if (page.run === undefined || running) {
    return undefined
  }
  return {
    canCollapse: hasProcess && !pinnedOpen(page.outcome, interjected),
    durationMs: span?.durationMs,
    endedAt: span?.endedAt,
    hasProcess,
    isOpen,
    outcome: page.outcome,
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
  /* 有插话的那一轮不折：过程里夹着人自己的话，折起来会把它一起藏掉。 */
  const interjected = interjectedIn(all)
  /* 在跑、被人叫停、自己坏掉、中途有人插话都不折。 */
  const isOpen = running || pinnedOpen(page.outcome, interjected) || (picked ?? false)
  const answer = answerStart(all, 0, all.length)
  const process = foldFrom(all, answer ?? all.length)
  const seal = sealOf(page, span, running, isOpen, process.length > 0, interjected)
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

/** 已封口那一段的派生，一次算好跨帧用：sealed 段封口之后不再改写，只有末段那一条还可能被收口，所以命中时复核它。 */
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

/** 运行中无条件展开；终止后才读取用户选择。生命周期来自状态机，span 只装饰耗时。 */
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

  /*
   * 运行状态行的两条判据：在跑才上屏；上面那一格有**看得见**的产出、且不是「我说的话」才画分隔线。
   * 直接跟在自己的气泡后面时不画 —— 那一行本来就是「我说完了，它开始动」，中间不该有分界。
   * 运行锚点不算产出：它自己不上屏，只负责承载封条，为它画一根线等于凭空多一道。
   */
  const above = tail.rows.at(-1) ?? prefix.segments.at(-1)?.rows.at(-1)
  const divided = above !== undefined && above.item.type !== SAID && above.item.type !== 'run_anchor'
  const runningPlan = running ? { divided, startedAt: activeSpan?.startedAt } : NO_RUNNING

  const result: Presentation = {
    count,
    latestOwnMessage: tail.ownMessage ?? prefix.latestOwnMessage,
    running: runningPlan,
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

/** 这一组里还在动的那一条，倒着找：卡片只报最后一条的状态。工具看终态，思考看是不是还挂在流式尾巴上。 */
export function liveMemberOf(plan: ToolGroupPlan): FeedRow | undefined {
  return plan.members.findLast((member) => member.isInFlight === true || member.isStreamingTail === true)
}
