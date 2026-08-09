import type { FeedRow, TurnSpan } from '@poietica/agent'

/*
 * 折叠是一次派生，不是一个状态。
 *
 * 输入是屏幕上真正在滚的那个数组、每一轮的起止、人手动点开过哪几轮；输出是交给
 * 列表的行，加上每一轮的封条落在哪里。这里不持有任何东西，所以「这一轮折没折」
 * 不可能与屏幕上显示的东西对不上。
 *
 * 封条在不在，只由一件事决定：这一轮有没有 span。span 是原生侧发出 run_started 时
 * 记下的，它同时是封条那只秒表的起点 —— 于是「有没有封条」与「秒表从几点算」是同
 * 一个事实，不会各说一套。此前它还要求这一轮已经有东西上屏，而思考不上屏
 * （renderable.ts 的 isRenderable 对 agent_thought 恒为假）：读者把原始思考链藏起来
 * 之后，模型推理的那一整段里一轮明明在跑，屏幕上却没有一样东西承认它在跑。
 *
 * 落点有两处，规则只有一条：封条排在它那一轮的内容前面。已经有行了，落点就是那一
 * 行；一行都还没有，落点就是转录尾部 —— 等待指示器正在那里。落定的一轮不会再有东
 * 西上屏，所以它一行都没有时就是真的什么也没发生过，不给它立一块空碑。
 *
 * 什么算最终回复，判据只有一条：这一轮末尾（跳过报错与授权这类旁白）那一条是
 * agent_text。不按类型认 —— 协议给不出「这条是最终回复」的标记，上游的
 * agent_message_chunk 只有 sessionUpdate 与 content 两格（kimi-code 的
 * events-map.ts），一句开场白与一句结论在报文里逐字同形。位置能分开它们：结论
 * 后面不会再有过程，开场白后面还有。所以模型先说一句再去调工具时，末尾不再是
 * agent_text，这一轮当场自动摊开继续滚 —— 折叠区永远精确等于「最后那段回复之前
 * 的全部过程」，不需要闩锁，也不会藏掉任何一条。
 */

export type TurnSealPlan = {
  readonly turn: number
  readonly startedAt: number
  readonly endedAt: number | undefined
  readonly hasProcess: boolean
  readonly isOpen: boolean
}

export type FoldedFeed = {
  readonly rows: readonly FeedRow[]
  readonly seals: ReadonlyMap<string, TurnSealPlan>
  /** 还没有行可落的那一枚：这一轮在跑，而它的第一样东西还没上屏。 */
  readonly tail: TurnSealPlan | undefined
}

export const NO_SEALS: ReadonlyMap<string, TurnSealPlan> = new Map()

/** 旁白：不是过程也不是回复。倒扫时跨过它，也永远不折。 */
const ASIDE: ReadonlySet<FeedRow['item']['type']> = new Set(['error', 'permission'])

const SAID: FeedRow['item']['type'] = 'user_message'

/** 一轮还什么都没上屏时共用同一个空数组。 */
const NO_ROWS: readonly number[] = []

export function foldFeed(
  rows: readonly FeedRow[],
  spans: readonly TurnSpan[],
  opened: ReadonlySet<number>,
): FoldedFeed {
  if (spans.length === 0) {
    return { rows, seals: NO_SEALS, tail: undefined }
  }

  const byTurn = groupByTurn(rows)
  const seals = new Map<string, TurnSealPlan>()
  const folded = new Set<number>()
  let tail: TurnSealPlan | undefined

  for (const span of spans) {
    const own = byTurn.get(span.turn) ?? NO_ROWS
    const unplaced = foldTurn(rows, span, own, opened, folded, seals)

    /* 落定的一轮不会再有东西上屏，一行都没有就是真的什么也没发生过；还在跑的那一轮
       不同 —— 它正在跑，而这恰恰是要说出来的那件事。 */
    if (unplaced !== undefined && span.endedAt === undefined) {
      tail = unplaced
    }
  }

  if (folded.size === 0) {
    /* 一行都没折就把入参原样交回：引用稳定是下游记忆化的前提。 */
    return { rows, seals: seals.size === 0 ? NO_SEALS : seals, tail }
  }

  return { rows: rows.filter((_, at) => !folded.has(at)), seals, tail }
}

/**
 * 折一轮：把要藏起来的过程行写进 folded，再把封条放到它的落点上。
 *
 * 落在行上就写进 seals；这一轮还没有行可落时把这枚封条交回去，归不归尾部由调用方按
 * 「它是不是还在跑」决定。
 */
function foldTurn(
  rows: readonly FeedRow[],
  span: TurnSpan,
  own: readonly number[],
  opened: ReadonlySet<number>,
  folded: Set<number>,
  seals: Map<string, TurnSealPlan>,
): TurnSealPlan | undefined {
  const answerAt = finalReplyIn(rows, own)
  const process = answerAt < 0 ? [] : processIn(rows, own, answerAt)
  /* 可点 ⟺ 真有东西可收。还没有回复时封条只是一行字，不给假按钮。 */
  const hasProcess = process.length > 0
  /* 人手动点开的轮次当场摊开；还没见到最终回复的那一轮本来就在滚，也摊开。 */
  const isOpen = opened.has(span.turn) || answerAt < 0
  const hidden = isOpen ? undefined : new Set(process)

  if (hidden !== undefined) {
    for (const at of hidden) {
      folded.add(at)
    }
  }

  const plan: TurnSealPlan = {
    turn: span.turn,
    /* 秒表量的是整轮：起点是 run_started 落账那一刻，终点是 run_finished /
       run_failed 那一刻 —— 两端都是原生侧盖下的墙钟，与「回复从哪一帧开始流」
       无关。还在跑的轮次没有终点，封条继续跳字。此前起点取第一帧、终点取回复
       的第一帧：一轮只有一段话时两端撞在同一帧上，耗时恒为 0s。 */
    startedAt: span.startedAt,
    endedAt: span.endedAt,
    hasProcess,
    isOpen,
  }

  /* 有行可落时，落在这一轮第一条「不是人话、且没被折掉」的行上面：收起时那是回复的
     首行，摊开时那是第一条过程 —— 两种状态下它都恰在提问与内容之间，不会挪。 */
  const anchor = own.find((at) => rows[at]?.item.type !== SAID && hidden?.has(at) !== true)
  const id = anchor === undefined ? undefined : rows[anchor]?.item.id

  if (id === undefined) {
    return plan
  }

  seals.set(id, plan)

  return undefined
}

/** 一趟分桶。按轮次逐轮筛一遍是 O(行×轮)，这条对话越长越贵。 */
function groupByTurn(rows: readonly FeedRow[]): Map<number, number[]> {
  const byTurn = new Map<number, number[]>()

  for (const [at, one] of rows.entries()) {
    const own = byTurn.get(one.item.turn)

    if (own === undefined) {
      byTurn.set(one.item.turn, [at])
    } else {
      own.push(at)
    }
  }

  return byTurn
}

function finalReplyIn(rows: readonly FeedRow[], own: readonly number[]): number {
  for (let index = own.length - 1; index >= 0; index -= 1) {
    const at = own[index]

    if (at === undefined) {
      continue
    }

    const type = rows[at]?.item.type

    if (type === undefined || ASIDE.has(type)) {
      continue
    }

    return type === 'agent_text' ? at : -1
  }

  return -1
}

function processIn(
  rows: readonly FeedRow[],
  own: readonly number[],
  answerAt: number,
): readonly number[] {
  return own.filter((at) => at < answerAt && isFrame(rows, at))
}

/** agent 的一帧：人问的那句不是，报错与授权这类旁白也不是。 */
function isFrame(rows: readonly FeedRow[], at: number): boolean {
  const type = rows[at]?.item.type

  return type !== undefined && type !== SAID && !ASIDE.has(type)
}
