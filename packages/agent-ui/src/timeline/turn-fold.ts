import type { FeedRow, TurnSpan } from '@poietica/agent'

/*
 * 折叠是一次派生，不是一个状态。
 *
 * 输入是屏幕上真正在滚的那个数组、每一轮的起止、人手动点开过哪几轮；输出是交给列表的
 * 行，以及每一轮的封条与回复操作落在哪一行。这里不持有任何领域事实，所以「这一轮折没
 * 折」不可能与屏幕上显示的东西对不上。
 *
 * 派生是增量的，不是每帧重算的。
 *
 * 这条规矩由 feed-rows.ts 与 conversation-turns.ts 立下，这一层照办。落定的一轮不会再有
 * 任何东西改变它的折法：reducer 只有两个写入点，两者都发生在当前段内，所以一轮一旦收
 * 尾，它的行、它的折点、它的封条与它的回复正文就都是常量。于是这里按轮记账，只重算真
 * 的变了的那一轮 —— 流式期间那就是最后一轮，代价是一轮的长度，不是整条对话的长度，更
 * 不是整条对话的字节数。
 *
 * 复用的判据必须包含 span 对象本身：markTurnEnd 会用终帧的时刻造出新的 span，那时行
 * 一个都没换，但封条上的秒表换了。
 *
 * 还在跑的那一轮永不复用：它中段的行可以换而首尾不换（模型说完一句又去调工具），首尾
 * 指针比不出来。没有 span 的轮次只在它不是行序里最后一轮时才算落定 —— 后面已经有别的
 * 轮次的行，说明它早就结束了。这一条只依赖行的形状，不依赖任何时间戳。
 *
 * 投影按 rows[0] 弱引用：一条对话每一帧的首行都是同一个对象，所以键天然按对话隔离，也
 * 随对话一起回收。
 *
 * 封条在不在，由两件事决定：这一轮有没有 span，以及模型有没有真的开过口。span 的起点同
 * 时是封条那只秒表的起点 —— 于是「有没有封条」与「秒表从几点算」是同一个事实，不会各说
 * 一套。但起点只证明请求出去了：额度耗尽的密钥同样有起点，光凭它立碑，「正在处理」会抢
 * 在报错前面亮一下。所以还要 span.firstFrameAt —— 收到第一帧 agent 内容的时刻，由
 * timeline-draft 在写入转录时盖章。它不能在这里算：思考不上屏（renderable.ts 的
 * isRenderable 对 agent_thought 恒为假），屏幕这一侧根本看不见模型已经在推理。
 *
 * 落点有两处，规则只有一条：封条排在它那一轮的内容前面。这一轮的提问就是那条界 —— 封条
 * 挂在提问那一行、渲染在它之后，于是收起摊开都不动它。提问不在（重连接续上的轮次）就既
 * 不立碑也不折叠：碑没有地方挂，而折起来的过程配不上开关。一行都还没有时落点是转录尾部
 * —— 等待指示器正在那里。落定的一轮不会再有东西上屏，所以它一行都没有时就是真的什么也
 * 没发生过，不给它立一块空碑。
 *
 * 折到哪里为止：这一轮最后那一段连续 agent_text 的起点，不要求它落在末尾。
 *
 * 两条通道。转录里只放内容 —— 人说的话、回答、报错与授权；过程（思考、工具调用、计划）
 * 在轮次还在跑的时候一律不进转录，它去转录尾部那块瞬态区。理由是虚拟列表：一行先上屏、
 * 再被移出数组，虚拟器的 count 与 getItemKey 当场改变，一整屏行重新落位。过程从出生就不
 * 在数组里，这件事因此不可能发生；一轮之内转录只会追加。标杆是同一套分法：Codex 的进度
 * 住 status_indicator_widget（底部瞬态区，随轮次收走），回答走 history_cell 进终端
 * scrollback —— 两条通道，两种寿命。
 *
 * 瞬态区的范围不由一个上限数字给出，由同一个边界给出：只收「最后一段回复之后」的帧。模
 * 型说完一句话，之前那段工作就已经归封条了，它不该还留在「现在正在做」里。
 *
 * 协议认不出最终回复 —— ACP 的 SessionUpdate 里没有终局位，一句开场白与一句结论在报文里
 * 逐字同形。既然认不出来就不认：每一次开口都把它之前的过程收进封条，最后一次开口自然就
 * 是最终回复。判据因此是单调的 —— 新的一段话只把边界往后推，随后的工具调用推不回去，流
 * 式追加也推不动它（追加改的是同一条 item，行下标不变）。
 */

export type TurnSealPlan = {
  readonly turn: number
  /** 缺席表示这台机器没有记下这一轮的两端：封条照立，但不报耗时。 */
  readonly startedAt: number | undefined
  readonly endedAt: number | undefined
  readonly hasProcess: boolean
  readonly isOpen: boolean
}

export type ReplyActionPlan = {
  /** 复制的是这一轮最后一段 AI 回复，不包含工具过程和旁白。 */
  readonly text: string
}

export type FoldedFeed = {
  readonly rows: readonly FeedRow[]
  /**
   * 每一轮至多一项，key 是该轮最后一个可见条目的 id。
   *
   * 操作区因此永远落在整轮内容之后，而不是跟着其中某一条 agent_text。
   */
  readonly replyActions: ReadonlyMap<string, ReplyActionPlan>
  readonly seals: ReadonlyMap<string, TurnSealPlan>
  /**
   * 这一段还没有结论的工作，按转录顺序。
   *
   * 它不在 rows 里，所以列表在一轮之内只会追加。读者是转录尾部那块瞬态区 —— 那里在虚拟
   * 器的条目表之外，改动只经过 paddingEnd，不碰 count、不碰 getItemKey，也不作废任何一
   * 行的实测高度。
   */
  readonly live: readonly FeedRow[]
  /** 还没有行可落的那一枚：这一轮在跑，而它的第一样东西还没上屏。 */
  readonly tail: TurnSealPlan | undefined
}

/* 空态一律交出同一个引用：下游按引用判等。 */
const NO_FEED_ROWS: readonly FeedRow[] = []
const NO_INDEXES: readonly number[] = []
const NO_SEALS: ReadonlyMap<string, TurnSealPlan> = new Map()
const NO_REPLY_ACTIONS: ReadonlyMap<string, ReplyActionPlan> = new Map()

const EMPTY: FoldedFeed = {
  rows: NO_FEED_ROWS,
  replyActions: NO_REPLY_ACTIONS,
  seals: NO_SEALS,
  live: NO_FEED_ROWS,
  tail: undefined,
}

/** 旁白：不是过程也不是回复。倒扫时跨过它，也永远不折。 */
const ASIDE: ReadonlySet<FeedRow['item']['type']> = new Set(['error', 'permission'])

const SAID: FeedRow['item']['type'] = 'user_message'

/** 一轮在 rows 里的界。一趟遍历只记三个数，不为每一轮分配下标数组。 */
interface TurnBounds {
  first: number
  last: number
  count: number
}

interface TurnIndex {
  readonly bounds: ReadonlyMap<number, TurnBounds>
  readonly order: readonly number[]
}

/** 复用判据要比的那几样东西：界的三个数，加界内首尾两个行对象。 */
interface TurnPlace {
  readonly first: number
  readonly last: number
  readonly count: number
  readonly head: FeedRow | undefined
  readonly foot: FeedRow | undefined
}

/** 一轮折完之后的全部结论。复用时整块沿用，连下标数组都不重建。 */
interface TurnFold {
  readonly span: TurnSpan | undefined
  readonly place: TurnPlace
  readonly isOpen: boolean
  /** 这一轮再也不会变。只有它为真时才可以沿用上一帧的结论。 */
  readonly settled: boolean
  readonly own: readonly number[]
  readonly hidden: readonly number[]
  readonly live: readonly FeedRow[]
  readonly seal: TurnSealPlan | undefined
  /** 封条挂在这一轮提问那一行的 id；undefined 表示这一轮没有提问可挂。 */
  readonly sealAt: string | undefined
  readonly replyAt: string | undefined
  readonly reply: ReplyActionPlan | undefined
}

interface FoldProjection {
  readonly rows: readonly FeedRow[]
  readonly spans: readonly TurnSpan[]
  readonly opened: ReadonlySet<number>
  readonly folds: ReadonlyMap<number, TurnFold>
  readonly result: FoldedFeed
}

interface SealPlan {
  readonly seals: ReadonlyMap<string, TurnSealPlan>
  readonly hidden: ReadonlySet<number>
  readonly live: readonly FeedRow[]
  readonly tail: TurnSealPlan | undefined
}

interface ReplyAnchor {
  readonly at: string
  readonly plan: ReplyActionPlan
}

const FOLDS = new WeakMap<FeedRow, FoldProjection>()

export function foldFeed(
  rows: readonly FeedRow[],
  spans: readonly TurnSpan[],
  opened: ReadonlySet<number>,
): FoldedFeed {
  const anchor = rows[0]

  if (anchor === undefined) {
    return EMPTY
  }

  const held = FOLDS.get(anchor)

  /* 三个入参一个都没换，答案就是上一次那个对象。滚动与无关状态变化因此一分不花。 */
  if (held !== undefined && held.rows === rows && held.spans === spans && held.opened === opened) {
    return held.result
  }

  const { bounds, order } = boundsOf(rows)
  const lastTurn = order[order.length - 1]
  const folds = new Map<number, TurnFold>()

  /* 有 span 的轮次先折。它们是唯一会被折叠、也是唯一会有封条的。 */
  for (const span of spans) {
    const bound = bounds.get(span.turn)
    /* 收了尾的一轮不会再变；不是行序里最后一轮的那些同样不会 —— 后面已经有别的轮次的行，
       说明它早就结束了。恢复出来的轮次两端都不知道（账本没盖住那一段），落定与否只能由
       后一条判据回答，而它只看行的形状，与任何时间戳无关。 */
    const done = span.endedAt !== undefined || span.turn !== lastTurn

    folds.set(span.turn, foldOf(rows, span.turn, span, bound, done, opened, held))
  }

  /* 剩下的是没有 span 的轮次：不折、不立碑，但有回复操作，也一样按轮记账。 */
  for (const turn of order) {
    if (folds.has(turn)) {
      continue
    }

    const done = turn !== lastTurn

    folds.set(turn, foldOf(rows, turn, undefined, bounds.get(turn), done, opened, held))
  }

  const sealed = sealsIn(spans, folds)
  const result: FoldedFeed = {
    rows: foldRows(rows, sealed.hidden),
    replyActions: repliesIn(order, folds),
    seals: sealed.seals,
    live: sealed.live,
    tail: sealed.tail,
  }

  FOLDS.set(anchor, { rows, spans, opened, folds, result })

  return result
}

/** 一趟遍历，记下每一轮的界与它第一次出现的次序。次序就是屏幕上从上往下的顺序。 */
function boundsOf(rows: readonly FeedRow[]): TurnIndex {
  const bounds = new Map<number, TurnBounds>()
  const order: number[] = []

  for (let at = 0; at < rows.length; at += 1) {
    const row = rows[at]

    if (row === undefined) {
      continue
    }

    const known = bounds.get(row.item.turn)

    if (known === undefined) {
      bounds.set(row.item.turn, { first: at, last: at, count: 1 })
      order.push(row.item.turn)
      continue
    }

    known.last = at
    known.count += 1
  }

  return { bounds, order }
}

/**
 * 汇总封条、要折起来的行、交给瞬态区的行，以及还没有行可落的那一枚。
 *
 * 只有有 span 的轮次进得来：没有 span 就没有封条，也就不会折掉任何一行。
 */
function sealsIn(spans: readonly TurnSpan[], folds: ReadonlyMap<number, TurnFold>): SealPlan {
  const seals = new Map<string, TurnSealPlan>()
  const hidden = new Set<number>()
  const live: FeedRow[] = []
  let tail: TurnSealPlan | undefined

  for (const span of spans) {
    const fold = folds.get(span.turn)

    if (fold?.seal === undefined) {
      continue
    }

    for (const at of fold.hidden) {
      hidden.add(at)
    }

    for (const row of fold.live) {
      live.push(row)
    }

    if (fold.sealAt !== undefined) {
      seals.set(fold.sealAt, fold.seal)
    } else if (span.endedAt === undefined && span.firstFrameAt !== undefined) {
      /* 落定的一轮一行都没有就是真的什么也没发生过；还在跑、且已经回过一帧的那一轮不
         同 —— 它正在跑，而这恰恰是要说出来的那件事。 */
      tail = fold.seal
    }
  }

  return {
    seals: seals.size === 0 ? NO_SEALS : seals,
    hidden,
    live: live.length === 0 ? NO_FEED_ROWS : live,
    tail,
  }
}

function repliesIn(
  order: readonly number[],
  folds: ReadonlyMap<number, TurnFold>,
): ReadonlyMap<string, ReplyActionPlan> {
  const replyActions = new Map<string, ReplyActionPlan>()

  for (const turn of order) {
    const fold = folds.get(turn)

    if (fold?.replyAt !== undefined && fold.reply !== undefined) {
      replyActions.set(fold.replyAt, fold.reply)
    }
  }

  return replyActions.size === 0 ? NO_REPLY_ACTIONS : replyActions
}

function foldRows(rows: readonly FeedRow[], hidden: ReadonlySet<number>): readonly FeedRow[] {
  /* 一行都没折就把入参原样交回：引用稳定是下游投影缓存的前提。 */
  if (hidden.size === 0) {
    return rows
  }

  return rows.filter((_, at) => !hidden.has(at))
}

/**
 * 折一轮：算出要藏起来的行、交给瞬态区的行、封条与它的落点、回复操作与它的落点。
 *
 * 落定的一轮先试复用。判据成立时这一轮的每一行都还是同一个对象，结论一律沿用。
 */
function foldOf(
  rows: readonly FeedRow[],
  turn: number,
  span: TurnSpan | undefined,
  bound: TurnBounds | undefined,
  settled: boolean,
  opened: ReadonlySet<number>,
  held: FoldProjection | undefined,
): TurnFold {
  const isOpen = opened.has(turn)
  const place = placeOf(rows, bound)
  const kept = held?.folds.get(turn)

  if (kept !== undefined && reusable(kept, span, isOpen, place)) {
    return kept
  }

  const own = ownOf(rows, turn, bound)
  /* 在跑 = 有起点、还没终点。两端都没有是「不知道」，不是「还在跑」—— 重放回来的对话
     一轮都不在跑，判成在跑会把整轮过程塞进瞬态区、收走回复操作，秒表还从此刻起空转。 */
  const running = span?.startedAt !== undefined && span.endedAt === undefined
  const answerAt = latestSpeechIn(rows, own)
  const process = span === undefined ? NO_INDEXES : processIn(rows, own, answerAt, running)
  /* 碑要有地方挂：这一轮的提问就是它的位置，而重连接续上的轮次连开头都没有。 */
  const saidAt = saidIn(rows, own)
  /* 可点 ⟺ 真有东西可收。什么都没收起时封条只是一行字，不给假按钮。 */
  const seal = saidAt === undefined ? undefined : sealOf(turn, span, isOpen, process.length > 0)
  /* 只有人手动点开才摊开：过程先上屏、回复一到再撤掉，撤掉的那一帧就是内容整段消失又
     出现。没有封条就一行都不折 —— 藏起来的过程配不上开关。 */
  const hidden = seal === undefined || isOpen ? NO_INDEXES : process
  const hiddenAt = new Set(hidden)
  const visibleOwn = hidden.length === 0 ? own : own.filter((at) => !hiddenAt.has(at))

  return {
    span,
    place,
    isOpen,
    settled,
    own,
    hidden,
    live: running ? liveIn(rows, hidden, answerAt) : NO_FEED_ROWS,
    seal,
    sealAt: seal === undefined ? undefined : saidAt,
    replyAt: replyIn(rows, visibleOwn, running)?.at,
    reply: replyIn(rows, visibleOwn, running)?.plan,
  }
}

function placeOf(rows: readonly FeedRow[], bound: TurnBounds | undefined): TurnPlace {
  const first = bound?.first ?? -1
  const last = bound?.last ?? -1

  return { first, last, count: bound?.count ?? 0, head: rows[first], foot: rows[last] }
}

/**
 * 能不能沿用上一帧对这一轮的结论。
 *
 * kept.settled 蕴含 kept.span 已收尾，配上 kept.span === span 就同时证明了本帧这一轮也已
 * 收尾，所以不需要再单独比一次「现在落定了没有」。
 */
function reusable(
  kept: TurnFold,
  span: TurnSpan | undefined,
  isOpen: boolean,
  place: TurnPlace,
): boolean {
  return (
    kept.settled &&
    kept.span === span &&
    kept.isOpen === isOpen &&
    kept.place.first === place.first &&
    kept.place.last === place.last &&
    kept.place.head === place.head &&
    kept.place.foot === place.foot &&
    kept.own.length === place.count
  )
}

/** 这一轮的行下标。只在界内走，并且逐条核对轮号 —— 不假设一轮的行在数组里连续。 */
function ownOf(
  rows: readonly FeedRow[],
  turn: number,
  bound: TurnBounds | undefined,
): readonly number[] {
  if (bound === undefined) {
    return NO_INDEXES
  }

  const own: number[] = []

  for (let at = bound.first; at <= bound.last; at += 1) {
    if (rows[at]?.item.turn === turn) {
      own.push(at)
    }
  }

  return own
}

/*
 * 秒表量的是整轮：起点是执行落账那一刻，终点是它收尾那一刻 —— 两端都是原生侧盖下的墙
 * 钟，与「回复从哪一帧开始流」无关。还在跑的轮次没有终点，封条继续跳字。
 *
 * 账本没盖住的那些轮次两端都不知道，它们的封条只剩另一半职责：过程收在这里。两半都没
 * 有时不立碑 —— 那会是一行既不报耗时、又收不起任何东西的字。
 */
function sealOf(
  turn: number,
  span: TurnSpan | undefined,
  isOpen: boolean,
  hasProcess: boolean,
): TurnSealPlan | undefined {
  if (span === undefined || (span.startedAt === undefined && !hasProcess)) {
    return undefined
  }

  return { turn, startedAt: span.startedAt, endedAt: span.endedAt, hasProcess, isOpen }
}

/**
 * 封条挂在这一轮的提问上，渲染在它之后（transcript-view 的 renderRowWithSeal）。
 *
 * 提问是这一轮唯一开合都在的那一行：它不是过程，折不掉；也不是回复，收不走。所以落点恒
 * 定 —— 封条那个按钮不再随开合从一行搬到另一行，两行的实测高度也不再当场作废。屏幕抽一
 * 下、按钮闪一下、行高作废，三个症状同一个根，根在这里。
 *
 * 视觉位置一分没挪：DOM 顺序仍是「提问、封条、内容」，只是封条从内容那一行的头上，换到
 * 了提问那一行的脚下。
 *
 * 没有提问的轮次交回 undefined，于是它不立碑也不折叠 —— 藏起来的过程配不上开关。
 */
function saidIn(rows: readonly FeedRow[], own: readonly number[]): string | undefined {
  for (const at of own) {
    const item = rows[at]?.item

    if (item?.type === SAID) {
      return item.id
    }
  }

  return undefined
}

/**
 * 还在跑、且还没被哪一句话盖过去的那几帧，交给瞬态区。
 *
 * 回复不交 —— 它是内容，归转录；被开口盖过的过程也不交 —— 它已经归封条了。
 */
function liveIn(
  rows: readonly FeedRow[],
  hidden: readonly number[],
  answerAt: number,
): readonly FeedRow[] {
  const live: FeedRow[] = []

  for (const at of hidden) {
    if (at <= answerAt) {
      continue
    }

    const row = rows[at]

    if (row !== undefined && row.item.type !== 'agent_text') {
      live.push(row)
    }
  }

  return live.length === 0 ? NO_FEED_ROWS : live
}

/**
 * 这一轮的回复操作：落点是折叠后最后一个可见条目，正文是最后一段连续 AI 发言。
 *
 * 两件事故意分开：最后一条可见内容可能是工具结果或错误记录，但按钮仍应出现在整轮最下
 * 面，复制的仍然只能是 AI 的回答。
 *
 * 正在跑的轮次没有「最终回复」。span 是首选事实来源；流式与执行中标记是无 span 的历史数
 * 据之外的额外保护，防止恢复边界上短暂出现一组过早的按钮。
 */
function replyIn(
  rows: readonly FeedRow[],
  own: readonly number[],
  running: boolean,
): ReplyAnchor | undefined {
  if (running) {
    return undefined
  }

  for (const at of own) {
    const row = rows[at]

    if (row?.isStreamingTail === true || row?.isInFlight === true) {
      return undefined
    }
  }

  const answerAt = latestSpeechIn(rows, own)

  if (answerAt < 0) {
    return undefined
  }

  const text = speechFrom(rows, own, answerAt)
  const anchorAt = own[own.length - 1]
  const anchor = anchorAt === undefined ? undefined : rows[anchorAt]

  if (text === undefined || anchor === undefined) {
    return undefined
  }

  return { at: anchor.item.id, plan: { text } }
}

/**
 * 最后那一段发言的正文。
 *
 * 从最后一段发言的起点向后只收 agent_text：工具调用、计划、报错和权限记录都不进剪贴板。
 * 多个连续文本条目之间保留段落边界。
 *
 * 这一趟拼接随这一轮的结论一起被记住，落定的一轮一辈子只拼一次。
 */
function speechFrom(
  rows: readonly FeedRow[],
  own: readonly number[],
  answerAt: number,
): string | undefined {
  const parts: string[] = []

  for (const at of own) {
    if (at < answerAt) {
      continue
    }

    const item = rows[at]?.item

    if (item?.type === 'agent_text') {
      parts.push(item.text)
    }
  }

  const text = parts.join('\n\n')

  return text.trim().length === 0 ? undefined : text
}

/**
 * 最后那一段连续 agent_text 从哪一行开始。倒着走：先找到最后一条回复，再沿着它往前收拢
 * 同一段，撞上第一条不是回复的帧就停。
 *
 * 跳过旁白，也跳过回复后面的过程 —— 后者正是单调的来源：模型说完又去干活时，这里交回的
 * 还是那句话的起点，边界不退。
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

/**
 * 这一轮要从转录里收起来的行。两条判据的并集。
 *
 * 回顾的那一条：最后那一段回复之前的一切。落定之后转录里剩下的就只有结论。
 *
 * 当下的那一条：还在跑的时候，这一轮的每一帧过程都收起来 —— 它们改由瞬态区呈现。
 */
function processIn(
  rows: readonly FeedRow[],
  own: readonly number[],
  answerAt: number,
  running: boolean,
): readonly number[] {
  const process: number[] = []

  for (const at of own) {
    if (!isFrame(rows, at)) {
      continue
    }

    if (at < answerAt || (running && rows[at]?.item.type !== 'agent_text')) {
      process.push(at)
    }
  }

  return process.length === 0 ? NO_INDEXES : process
}

/** agent 的一帧：人问的那句不是，报错与授权这类旁白也不是。 */
function isFrame(rows: readonly FeedRow[], at: number): boolean {
  const type = rows[at]?.item.type

  return type !== undefined && type !== SAID && !ASIDE.has(type)
}
