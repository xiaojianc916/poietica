import type { FeedRow } from './feed-rows'
import { sharedPrefix } from './feed-rows'
import type { TimelineItem, TimelineItemId } from './timeline-contract'

/**
 * 轨道读到的那些轮次。
 *
 * 它建在行之上，不在条目之上：一格的位置是行下标，因为滚动区只认行 —— 这一层
 * 不量任何像素。入参就是 selectFeedRows 的产物：两条管线之间只有这一条边，方向
 * 单一，所以它们本来就不该挤在同一个文件里。
 *
 * 增量的道理与行投影相同，边界不同：共享前缀里最后那一轮的预览要往后扫到下一轮
 * 为止，仍可能被前缀之后的行改写，所以它跟着重算；再往前的轮次一个字都不会变。
 */

/** 空态交出同一个数组：下游按引用判等。 */
const NO_TURNS: readonly ConversationTurn[] = []

/**
 * The turns of the conversation, as the rail reads them.
 *
 * A turn opens where the user speaks: everything after a question belongs to
 * the answer to it, so the questions alone are the table of contents. The
 * position of a turn is a feed row index, because the scrollport addresses
 * rows and nothing else — no pixel is measured to build this.
 *
 * 但一问之后什么都没发生,就不是一轮。
 *
 * 断网、鉴权失败、空转 —— 这一问的跨度里只有一条 error,或者干脆一条都没有,
 * 然后人又问了一遍。屏幕上那是两个挤在一起的气泡,轨道上却是两格、序数多算
 * 一轮,而点第一格会落到一个没有内容的位置。判据本来就在手边:下面第二趟扫描
 * 为了取预览,已经在遍历这一轮的跨度了。
 *
 * 没有应答的那一问并进下一格,并把入口行号带过去 —— 落点仍在这一串气泡的最
 * 上面,一个都不跳过;标题用真正得到回答的那一问,因为那才是读者要找的东西。
 */
export interface ConversationTurn {
  readonly id: TimelineItemId
  readonly rowIndex: number
  /** The first line of the question: what the rail labels the turn with. */
  readonly label: string
  /**
   * The opening text of the AI answer, for the preview card.
   *
   * Absent while the turn has not yet received a reply. Capped at 300
   * characters — the card never renders more than three lines.
   */
  readonly reply?: string
}

/** 一次收集的产物：提出这一轮的那一行，加上它的位置与标题。 */
interface StagedTurn {
  readonly row: FeedRow
  readonly id: TimelineItemId
  readonly rowIndex: number
  readonly label: string
}

/*
 * 一轮的身份，和提出它的那一行一样长寿。
 *
 * 复用条件只看 rowIndex 与 reply：id 与 label 都是这一行自己的函数，而行就是
 * 键 —— 键相同它们不可能不同，比较它们只是自我安慰。
 */
const TURN_OF = new WeakMap<FeedRow, ConversationTurn>()

function toTurn(entry: StagedTurn, reply: string | undefined): ConversationTurn {
  const held = TURN_OF.get(entry.row)

  if (held !== undefined && held.rowIndex === entry.rowIndex && held.reply === reply) {
    return held
  }

  /*
   * exactOptionalPropertyTypes 打开时，reply?: string 不接受显式的 undefined，
   * 所以按有无分两支构造。
   */
  const turn: ConversationTurn =
    reply === undefined
      ? { id: entry.id, label: entry.label, rowIndex: entry.rowIndex }
      : { id: entry.id, label: entry.label, reply, rowIndex: entry.rowIndex }

  TURN_OF.set(entry.row, turn)

  return turn
}

interface TurnProjection {
  readonly rows: readonly FeedRow[]
  readonly turns: readonly ConversationTurn[]
}

const TURNS = new WeakMap<FeedRow, TurnProjection>()

export function selectTurns(rows: readonly FeedRow[]): readonly ConversationTurn[] {
  const anchor = rows[0]

  if (anchor === undefined) {
    return NO_TURNS
  }

  const held = TURNS.get(anchor)

  if (held !== undefined && held.rows === rows) {
    return held.turns
  }

  const built = buildTurns(rows, held)

  TURNS.set(anchor, { rows, turns: built })

  return built
}

/**
 * 这一条在屏幕上留下东西了吗。
 *
 * 一格 = 一次留下过痕迹的往返。判据只有这一句,而且写成对 TimelineItem 的穷尽
 * switch,不是「排除 error」的黑名单 —— 黑名单有个静默的结构性缺陷:以后新增
 * 任何条目类型,它默认判成「发生过」,于是又一种空轮次被算成一站,而没有一个
 * 地方会报错。这里的 never 让新类型必须先回答自己算不算一站,答不上来编译不过。
 *
 * 报错是讣告,不是目的地:断网、鉴权失败、额度耗尽、reducer 记下的空转,跨度里
 * 都只有一条 error,人接着又问了一遍 —— 屏幕上那是挤在一起的两个气泡,轨道上
 * 不该是两站。permission 本来就不渲染。空字符串的 agent_text 渲染出来什么都
 * 没有,同理不算。没结清的题长在输入框那张卡里,同理不算;结清的题在转录里留卡,
 * 算一站。
 */
function leavesAMark(item: TimelineItem): boolean {
  switch (item.type) {
    case 'agent_text':
    case 'agent_thought':
      return item.text.trim().length > 0
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
    default: {
      const exhaustive: never = item

      return Boolean(exhaustive)
    }
  }
}

/*
 * 上一份投影里，前面几轮可以原样留着。
 *
 * 一轮的预览要往后扫到下一轮为止，所以共享前缀里最后那一轮的答复仍可能被
 * 前缀之后的行改写 —— 它跟着一起重算。再往前的轮次，扫描区间整个落在共享
 * 前缀里，一个字都不会变。
 */
function reuseFrom(held: TurnProjection, shared: number): { keep: number; from: number } {
  let keep = 0

  while (
    keep < held.turns.length &&
    (held.turns[keep + 1]?.rowIndex ?? Number.POSITIVE_INFINITY) <= shared
  ) {
    keep += 1
  }

  return { keep, from: Math.min(held.turns[keep]?.rowIndex ?? shared, shared) }
}

/** 第一趟：从重算起点开始，收下每一句人说的话和它的行号。 */
function stageTurns(rows: readonly FeedRow[], from: number): StagedTurn[] {
  const staged: StagedTurn[] = []

  for (let rowIndex = from; rowIndex < rows.length; rowIndex += 1) {
    const row = rows[rowIndex]

    if (row !== undefined && row.item.type === 'user_message') {
      staged.push({ id: row.item.id, label: firstLine(row.item.text), row, rowIndex })
    }
  }

  return staged
}

/** 一轮的跨度里留下了什么：预览取哪一段，以及它到底算不算发生过。 */
interface Span {
  readonly answered: boolean
  readonly reply: string | undefined
}

/*
 * 第二趟：一轮向后扫到下一轮为止，一趟回答上面那两件事。
 *
 * 「发生过」由 leavesAMark 一句话回答，它是对条目类型的穷尽判断，不是一张
 * 列举失败情形的名单 —— 断网、鉴权、空转、发了三条才等到回答、一个字没吐就
 * 被打断，都落在同一条判据下，不需要各自加一个分支。
 *
 * 取到第一段答复就收手：卡片只画三行，后面扫多远都改不了它。
 */
function scanSpan(rows: readonly FeedRow[], start: number, until: number): Span {
  let answered = false

  for (let index = start; index < until; index += 1) {
    const item = rows[index]?.item

    if (item === undefined || !leavesAMark(item)) {
      continue
    }

    answered = true

    if (item.type === 'agent_text') {
      return { answered: true, reply: item.text.slice(0, 300) }
    }
  }

  return { answered, reply: undefined }
}

/*
 * 收下来的那些问，折成轨道上的格子。
 *
 * 最后一轮永远不折叠：折叠要求后面还有人再问，而正在跑的那一轮没有下一问。
 */
function foldTurns(rows: readonly FeedRow[], staged: readonly StagedTurn[]): ConversationTurn[] {
  const rebuilt: ConversationTurn[] = []
  let carried: number | undefined

  for (let position = 0; position < staged.length; position += 1) {
    const entry = staged[position]

    if (entry === undefined) {
      continue
    }

    const until = staged[position + 1]?.rowIndex ?? rows.length
    const { answered, reply } = scanSpan(rows, entry.rowIndex + 1, until)

    /* 没人应答，而后面还有人再问：这一问是下一格的开头，不是它自己的一格。 */
    if (!answered && position + 1 < staged.length) {
      carried ??= entry.rowIndex
      continue
    }

    rebuilt.push(toTurn(carried === undefined ? entry : { ...entry, rowIndex: carried }, reply))
    carried = undefined
  }

  return rebuilt
}

function buildTurns(
  rows: readonly FeedRow[],
  held: TurnProjection | undefined,
): readonly ConversationTurn[] {
  if (held === undefined) {
    return foldTurns(rows, stageTurns(rows, 0))
  }

  const { from, keep } = reuseFrom(held, sharedPrefix(held.rows, rows))
  const rebuilt = foldTurns(rows, stageTurns(rows, from))
  const built = keep === 0 ? rebuilt : [...held.turns.slice(0, keep), ...rebuilt]

  /* 缩略导航是 memo 过的：轮次没变就必须是同一个数组。 */
  return built.length === held.turns.length && sharedPrefix(held.turns, built) === built.length
    ? held.turns
    : built
}

function firstLine(text: string): string {
  return text.trim().split('\n', 1)[0] ?? ''
}
