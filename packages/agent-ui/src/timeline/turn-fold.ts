import type { FeedRow, TurnSpan } from '@poietica/agent'

/*
 * 折叠是一次派生，不是一个状态。
 *
 * 输入是屏幕上真正在滚的那个数组、每一轮的起止、人手动点开过哪几轮；输出是交给
 * 列表的行，加上每一轮的封条落在哪里。这里不持有任何东西，所以「这一轮折没折」
 * 不可能与屏幕上显示的东西对不上。
 *
 * 封条在不在，由两件事决定：这一轮有没有 span，以及模型有没有真的开过口。
 *
 * span 是原生侧发出 run_started 时记下的，它同时是封条那只秒表的起点 —— 于是「有没有
 * 封条」与「秒表从几点算」是同一个事实，不会各说一套。但起点只证明请求出去了：额度
 * 耗尽的密钥同样有起点，光凭它立碑，「正在处理」会抢在报错前面亮一下。所以还要
 * span.firstFrameAt —— 收到第一帧 agent 内容的时刻，由 timeline-draft 在写入转录时
 * 盖章。它不能在这里算：思考不上屏（renderable.ts 的 isRenderable 对 agent_thought
 * 恒为假），屏幕这一侧根本看不见模型已经在推理。
 *
 * 落点有两处，规则只有一条：封条排在它那一轮的内容前面。已经有行了，落点就是那一
 * 行；一行都还没有，落点就是转录尾部 —— 等待指示器正在那里。落定的一轮不会再有东
 * 西上屏，所以它一行都没有时就是真的什么也没发生过，不给它立一块空碑。
 *
 * 折到哪里为止：这一轮最后那一段连续 agent_text 的起点，不要求它落在末尾。
 *
 * 协议认不出最终回复 —— ACP 的 SessionUpdate 十三个变体里没有终局位，上游的
 * agent_message_chunk 只有 sessionUpdate 与 content 两格（kimi-code 的
 * events-map.ts），一句开场白与一句结论在报文里逐字同形。既然认不出来就不认：每一次
 * 开口都把它之前的过程收进封条，最后一次开口自然就是最终回复。
 *
 * 判据因此是单调的 —— 新的一段话只把边界往后推，随后的工具调用推不回去，流式追加也
 * 推不动它（追加改的是同一条 item，行下标不变）。此前要求末尾那一条是 agent_text，
 * 于是模型说完一句又去干活时边界当场退回 -1：已经收起的过程整段弹回屏幕，封条的落点
 * 也跟着从回复那一行退回过程第一行 —— 宿主一换就是一次卸载重挂，连封条自己都在闪。
 * 单调之后这两件事都不可能发生。
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
       不同 —— 它正在跑，而这恰恰是要说出来的那件事。但「在跑」要有证据：一帧都还没
       收到时只让等待指示器说话，不拿封条替一个还没回过话的请求作证。 */
    if (unplaced !== undefined && span.endedAt === undefined && span.firstFrameAt !== undefined) {
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
  const answerAt = latestSpeechIn(rows, own)
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

/**
 * 最后那一段连续 agent_text 从哪一行开始。倒着走：先找到最后一条回复，再沿着它往前
 * 收拢同一段，撞上第一条不是回复的帧就停。
 *
 * 跳过旁白，也跳过回复后面的过程 —— 后者正是单调的来源：模型说完又去干活时，这里
 * 交回的还是那句话的起点，边界不退。
 */
function latestSpeechIn(rows: readonly FeedRow[], own: readonly number[]): number {
  let start = -1

  for (let index = own.length - 1; index >= 0; index -= 1) {
    const at = own[index]

    if (at === undefined) {
      continue
    }

    const type = rows[at]?.item.type

    if (type === undefined || ASIDE.has(type)) {
      continue
    }

    if (type === 'agent_text') {
      start = at
      continue
    }

    if (start >= 0) {
      break
    }
  }

  return start
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
