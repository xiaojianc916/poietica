import { isTerminal } from './acp-projection'
import { isRenderable } from './renderable'
import type { TimelineItem, TimelineState } from './timeline-contract'
import { selectIsBusy } from './timeline-queries'

/**
 * Read models for the activity feed.
 *
 * 派生是增量的，不是每帧重算的。
 *
 * reducer 只有两个写入点（timeline-reducer.ts 的 push 与 draft.items[position]
 * = …），两者都是追加或就地替换，所以相邻两帧的 items 共享一段前缀，且共享的
 * 那一段里每一项都是同一个对象。派生因此只需要从第一处引用不同的地方往后重算。
 *
 * 此前这里是反过来的：buildFeedRows 每帧 filter + map 整条 items，buildTurns
 * 每帧重建全部轮次，然后由六张 WeakMap 与一个 stable() 在事后判断「其实没变」。
 * 那些表挡住的是下游的重渲染，挡不住上游的重算 —— 而重算是 O(N)/帧，N 是这条
 * 对话的长度，帧率是模型吐字的速度。文件里三处注释互相解释「这一层盖不住那一
 * 层」，那是补丁叠补丁的自证，不是设计。
 *
 * 换成变更驱动之后，剩下两张身份表（ROWS、TURN_OF）与两张投影表。投影按
 * items[0] / rows[0] 弱引用：一条对话每一帧的首项都是同一个对象，所以键天然
 * 按对话隔离，也随对话一起回收。
 */

export interface FeedRow {
  readonly item: TimelineItem
  /** The tail entry of a live run: the only row allowed to grow in place. */
  readonly isStreamingTail: boolean
  /**
   * 这一条属于此刻还在跑的那一轮。
   *
   * 工具卡片据此决定纺锤转不转。status 装的是协议值，也就是 agent 说过的话，
   * 而 ACP 只有 pending/in_progress/completed/failed 四档 ——「这次调用还在不
   * 在跑」它根本表达不了，那是这一层从轮次状态推出来的。
   *
   * 按轮次划，不是按整条对话划：上一轮留下的没有结局的调用，不会因为下一轮
   * 开始跑而重新转起来。
   *
   * 只有工具调用这一行会是 true。别的条目不读这一格，就不该因为它换身份 ——
   * 行的身份是 TimelineRow 的 memo 判据，一轮结束时把整轮的行全换一遍，等于
   * 白重渲染一整轮，其中包括每一段 Prose。turn-identity.test.ts 守着这条。
   */
  readonly isInFlight: boolean
}

/** 空态交出同一个数组：下游按引用判等。 */
const NO_ROWS: readonly FeedRow[] = []

/*
 * 一行的身份，和它描述的那一条一样长寿。
 *
 * reducer 每帧只换掉被这一帧碰过的那一条，所以把行记在条目上，就把「尾巴长了
 * 一点」变成一行改变，而不是一整份新转录。
 */
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

interface FeedProjection {
  readonly items: readonly TimelineItem[]
  /** items 下标 → 行下标；-1 表示这一条不上屏。行与条目不一一对应。 */
  readonly rowOf: readonly number[]
  readonly rows: readonly FeedRow[]
  readonly live: boolean
  /**
   * 这一份投影是按哪一个段号算的。
   *
   * turnStart 只随换段移动（见下方求值处），所以复用它需要的正是这一格。
   */
  readonly runIndex: number
  /** 当前这一轮从哪一条开始。它之前的条目一律不在飞。 */
  readonly turnStart: number
}

const FEEDS = new WeakMap<TimelineItem, FeedProjection>()

/** 共享前缀能留下多少行：前缀里最后一条上屏条目的行号加一。 */
function keptRows(held: FeedProjection, shared: number): number {
  for (let index = shared - 1; index >= 0; index -= 1) {
    const at = held.rowOf[index] ?? -1

    if (at >= 0) {
      return at + 1
    }
  }

  return 0
}

/** 沿用共享前缀那一段，只把它之后的条目投影成行。 */
function projectRows(
  held: FeedProjection | undefined,
  items: readonly TimelineItem[],
  shared: number,
  turnStart: number,
): { rowOf: number[]; rows: FeedRow[] } {
  const rowOf: number[] = held === undefined ? [] : held.rowOf.slice(0, shared)
  const rows: FeedRow[] = held === undefined ? [] : held.rows.slice(0, keptRows(held, shared))

  for (let index = shared; index < items.length; index += 1) {
    const item = items[index]

    if (item === undefined || !isRenderable(item)) {
      rowOf.push(-1)
      continue
    }

    rowOf.push(rows.length)
    rows.push(toRow(item, false, inFlightAt(item, index, turnStart)))
  }

  return { rowOf, rows }
}

/**
 * 这一条此刻还在飞吗。
 *
 * 只有工具调用回答得了这个问题，也只有它在读这一格。别的条目一律 false ——
 * 上一版把当前轮次的每一行都标了，于是一轮结束时那一轮所有行的身份一起翻新，
 * 而其中绝大多数根本不看这一格。行的身份是 TimelineRow 的 memo 判据，那等于
 * 白重渲染一整轮。turn-identity.test.ts 当场把它抓了出来。
 *
 * 类型判断同时消掉了另一处错：index >= turnStart 是闭区间，而 turnStart 正是
 * 提问那一条自己的下标 —— 一个用户消息「还在飞」本来就不成立。
 */
function inFlightAt(item: TimelineItem, index: number, turnStart: number): boolean {
  /* 终态不在飞。此前这一格里没有 status，于是本轮内已经 completed 或 failed 的
     卡片只要还落在当前段内就一直转纺锤 —— 一轮里先跑几个短工具、再挂一个长时间
     的 Agent 子代理时，屏幕上是一整轮集体转圈，人分不出哪一个还在跑。
     判据不在这里重写一遍：isTerminal 是 acp-projection 里那一份，endedAt 记不记
     也是照它。同一个概念两处判断，迟早会各自漂移。 */
  return item.type === 'tool_call' && index >= turnStart && !isTerminal(item.status)
}

/** 会长大的只有末尾那一条，而且只在一轮还在跑的时候。 */
function growTail(rows: FeedRow[], live: boolean): void {
  const last = rows.length - 1
  const tail = rows[last]

  if (tail !== undefined) {
    rows[last] = toRow(tail.item, live && isGrowable(tail.item), tail.isInFlight)
  }
}

/**
 * 这一帧的内容与上一帧逐字相同吗。
 *
 * 常数时间：共享前缀覆盖了全部条目、行数又相同，那么唯一可能换过的就是尾行。
 * 此前这件事的做法是「先全量重建，再逐项比较，命中就把刚建的整份丢掉」。
 */
function isSettled(
  held: FeedProjection,
  items: readonly TimelineItem[],
  shared: number,
  rows: readonly FeedRow[],
): boolean {
  if (shared !== items.length || shared !== held.items.length) {
    return false
  }

  if (rows.length !== held.rows.length) {
    return false
  }

  const last = rows.length - 1

  return last < 0 || rows[last] === held.rows[last]
}

/**
 * 当前这一段的产出从哪一条开始。
 *
 * 判据是条目自己的段号：反着走，走出本段就到头了。代价是这一轮的长度，不是整条
 * 对话的长度。
 *
 * 此前这里找的是「人说的最后一句话」—— 一个反推，而且在人于轮次进行中又说一句
 * 时会当场跳到新那句：上一轮还在跑的调用全部被判成不在飞，纺锤停转；更贵的是
 * boundary 跟着回退，整轮重投影、整轮的行身份翻新，而行身份正是 TimelineRow 的
 * memo 判据。段号由 run_started 划定，它不会因为有人插话而移动。
 *
 * 提问那一条记的是上一段的号（它先于 run_started 到达），所以起点落在它之后 ——
 * 本来就该如此：一条用户消息不会「在飞」。
 */
function turnStartOf(items: readonly TimelineItem[], turn: number): number {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]

    if (item !== undefined && item.turn !== turn) {
      return index + 1
    }
  }

  return 0
}

export function selectFeedRows(state: TimelineState): readonly FeedRow[] {
  const items = state.items
  const anchor = items[0]

  if (anchor === undefined) {
    return NO_ROWS
  }

  const live = selectIsBusy(state)
  const held = FEEDS.get(anchor)

  if (held !== undefined && held.items === items && held.live === live) {
    return held.rows
  }

  /*
   * 在飞的范围就是当前这一段。没在跑就没有人在飞，整条对话都不在。
   *
   * 段的起点不随流式追加移动：新条目一律带着当前段号追加在末尾，而已有条目的段号
   * 一旦写下就不再改（reducer 的就地替换整份沿用 turn）。所以段号没变时，它恒是
   * 上一帧那个数。
   *
   * 此前每一帧都从末端倒扫一遍整段去求它 —— 代价是这一轮的长度乘以帧率，而答案
   * 每一帧都相同。倒扫现在只发生在换段的那一帧，那时段里只有一条。
   */
  const turnStart = !live
    ? items.length
    : held?.live && held.runIndex === state.runIndex
      ? held.turnStart
      : turnStartOf(items, state.runIndex)

  /*
   * 在飞的范围变了，共享前缀就不能一路沿用到底：那一段里的行还带着上一次的
   * isInFlight，而 growTail 只修得了尾行。回退到两次范围里更靠前的那一个，
   * 重投影的量因此以一轮为界，而不是整条对话。
   *
   * 它一轮只发生两次（开始、结束）。流式追加时范围没变，这里是 items.length，
   * 增量那条路一个字节都没改。
   */
  const boundary =
    held === undefined || (held.live === live && held.turnStart === turnStart)
      ? items.length
      : Math.min(held.turnStart, turnStart)

  const shared = held === undefined ? 0 : Math.min(sharedPrefix(held.items, items), boundary)
  const { rowOf, rows } = projectRows(held, items, shared, turnStart)

  growTail(rows, live)

  /* 内容没变就交还上一份数组：下游按引用判等。 */
  const settled = held !== undefined && isSettled(held, items, shared, rows) ? held.rows : rows

  FEEDS.set(anchor, { items, rowOf, rows: settled, live, runIndex: state.runIndex, turnStart })

  return settled
}

/**
 * 这一轮在跑，而屏幕上没有一样东西在动。
 *
 * 等待指示器唯一的出现条件。判据落在末尾那一行：回答正在写（isStreamingTail）、
 * 调用正在跑（isInFlight），动的那个东西自己就是进度，再挂一个转圈是两个人报同
 * 一件事；两者都不成立时模型在推理，而推理不上屏（renderable.ts），转录一个字都
 * 不会变——那段静止正是这一格要补的。
 *
 * 问的是行而不是条目：「屏幕上有没有东西在动」本来就是屏幕的性质。
 *
 * awaiting_permission 不在其中：那一刻输入框上方摊着审批带，等的是人，不是模型。
 */
export function selectIsWaiting(state: TimelineState): boolean {
  if (state.status !== 'running') {
    return false
  }

  const tail = selectFeedRows(state).at(-1)

  return tail === undefined || !(tail.isStreamingTail || tail.isInFlight)
}

/* 会长大的只有回答：思考不上屏，它永远不会是一行。 */
function isGrowable(item: TimelineItem): boolean {
  return item.type === 'agent_text'
}
