import type { FeedRow, TurnSpan } from '@poietica/agent'

/*
 * 折叠是一次派生，不是一个状态。
 *
 * 输入是屏幕上真正在滚的那个数组、每一轮的起止、人手动点开过哪几轮；输出是交给列表
 * 的行，以及每一轮的封条与回复操作落在哪一行。这里不持有任何领域事实，所以「这一轮
 * 折没折」不可能与屏幕上显示的东西对不上。
 *
 * 派生是增量的，不是每帧重算的。
 *
 * 这条规矩由 feed-rows.ts 与 conversation-turns.ts 立下，这一层照办：落定的一轮不会
 * 再有任何东西改变它的折法 —— reducer 只有两个写入点（timeline-reducer.ts 的 push 与
 * draft.items[position] = …），两者都发生在当前段内，所以一轮一旦有了 endedAt，它的行、
 * 它的折点、它的封条与它的回复正文就都是常量。于是这里按轮记账，只重算真的变了的那
 * 一轮；流式期间那就是最后一轮，代价是一轮的长度，而不是整条对话的长度，更不是整条
 * 对话的字节数。
 *
 * 复用的判据必须包含 span 对象本身：restampTurns 会用账本里的两端造出新的 span，那时
 * 行一个都没换，但封条上的秒表换了。
 *
 * 还在跑的那一轮永不复用。它中段的行可以换而首尾不换（模型说完一句又去调工具），首尾
 * 指针比不出来。
 *
 * 投影按 rows[0] 弱引用：一条对话每一帧的首行都是同一个对象，所以键天然按对话隔离，
 * 也随对话一起回收。
 *
 * 封条在不在，由两件事决定：这一轮有没有 span，以及模型有没有真的开过口。span 是原生侧
 * 发出 run_started 时记下的，它同时是封条那只秒表的起点 —— 于是「有没有封条」与「秒表
 * 从几点算」是同一个事实，不会各说一套。但起点只证明请求出去了：额度耗尽的密钥同样有
 * 起点，光凭它立碑，「正在处理」会抢在报错前面亮一下。所以还要 span.firstFrameAt ——
 * 收到第一帧 agent 内容的时刻，由 timeline-draft 在写入转录时盖章。它不能在这里算：思考
 * 不上屏（renderable.ts 的 isRenderable 对 agent_thought 恒为假），屏幕这一侧根本看不见
 * 模型已经在推理。
 *
 * 落点有两处，规则只有一条：封条排在它那一轮的内容前面。已经有行了，落点就是那一行；
 * 一行都还没有，落点就是转录尾部 —— 等待指示器正在那里。落定的一轮不会再有东西上屏，
 * 所以它一行都没有时就是真的什么也没发生过，不给它立一块空碑。
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
 * 瞬态区的范围不由一个上限数字给出，由同一个边界给出：只收「最后一段回复之后」的帧。
 * 模型说完一句话，之前那段工作就已经归封条了，它不该还留在「现在正在做」里。
 *
 * 协议认不出最终回复 —— ACP 的 SessionUpdate 里没有终局位，一句开场白与一句结论在报文里
 * 逐字同形。既然认不出来就不认：每一次开口都把它之前的过程收进封条，最后一次开口自然
 * 就是最终回复。判据因此是单调的 —— 新的一段话只把边界往后推，随后的工具调用推不回去，
 * 流式追加也推不动它（追加改的是同一条 item，行下标不变）。
 */

export type TurnSealPlan = {
  readonly turn: number
  readonly startedAt: number
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
   * 它不在 rows 里，所以列表在一轮之内只会追加。读者是转录尾部那块瞬态区
   * （transcript-view.tsx 的 footer）—— 那里在虚拟器的条目表之外，改动只经过
   * paddingEnd，不碰 count、不碰 getItemKey，也不作废任何一行的实测高度。
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

/**
 * 一轮在 rows 里的位置。
 *
 * 一趟遍历只记三个数，不为每一轮分配下标数组 —— 数组只在这一轮真的要重算时才建。
 */
interface TurnBounds {
  first: number
  last: number
  count: number
}

/** 一轮折完之后的全部结论。复用时整块沿用，连下标数组都不重建。 */
interface TurnFold {
  readonly span: TurnSpan | undefined
  readonly first: number
  readonly last: number
  readonly head: FeedRow | undefined
  readonly foot: FeedRow | undefined
  readonly isOpen: boolean
  /** 有 span 且已有终点。只有它为真时这一轮才是常量，才可以复用。 */
  readonly settled: boolean
  /** 这一轮的行下标，升序。 */
  readonly own: readonly number[]
  /** 要从转录里收起来的行下标，升序。 */
  readonly hidden: readonly number[]
  /** 交给瞬态区的行，按转录顺序。 */
  readonly live: readonly FeedRow[]
  /** 没有 span 的轮次没有封条。 */
  readonly seal: TurnSealPlan | undefined
  /** 封条落在哪一行的 id；undefined 表示这一轮还没有行可落。 */
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
  const folds = new Map<number, TurnFold>()

  /* 有 span 的轮次先折。它们是唯一会被折叠、也是唯一会有封条的。 */
  for (const span of spans) {
    folds.set(span.turn, foldOf(rows, span.turn, span, bounds.get(span.turn), opened, held))
  }

  /* 剩下的是没有 span 的轮次（旧版恢复出来的历史会话）：不折、不立碑，但有回复操作。 */
  for (const turn of order) {
    if (!folds.has(turn)) {
      folds.set(turn, foldOf(rows, turn, undefined, bounds.get(turn), opened, held))
    }
  }

  const seals = new Map<string, TurnSealPlan>()
  const hidden = new Set<number>()
  const live: FeedRow[] = []
  let tail: TurnSealPlan | undefined

  for (const span of spans) {
    const fold = folds.get(span.turn)

    if (fold === undefined || fold.seal === undefined) {
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
      continue
    }

    /* 落定的一轮不会再有东西上屏，一行都没有就是真的什么也没发生过；还在跑的那一轮
		   不同 —— 它正在跑，而这恰恰是要说出来的那件事。但「在跑」要有证据：一帧都还没
		   收到时只让等待指示器说话，不拿封条替一个还没回过话的请求作证。 */
    if (span.endedAt === undefined && span.firstFrameAt !== undefined) {
      tail = fold.seal
    }
  }

  /* 一行都没折就把入参原样交回：引用稳定是下游记忆化的前提。 */
  const visible = hidden.size === 0 ? rows : rows.filter((_, at) => !hidden.has(at))

  /* 回复操作按行的先后落，一轮至多一项。 */
  const replyActions = new Map<string, ReplyActionPlan>()

  for (const turn of order) {
    const fold = folds.get(turn)

    if (fold?.replyAt !== undefined && fold.reply !== undefined) {
      replyActions.set(fold.replyAt, fold.reply)
    }
  }

  const result: FoldedFeed = {
    rows: visible,
    replyActions: replyActions.size === 0 ? NO_REPLY_ACTIONS : replyActions,
    seals: seals.size === 0 ? NO_SEALS : seals,
    live: live.length === 0 ? NO_FEED_ROWS : live,
    tail,
  }

  FOLDS.set(anchor, { rows, spans, opened, folds, result })

  return result
}

/**
 * 一趟遍历，记下每一轮的界与它第一次出现的次序。
 *
 * 次序拿来定回复操作的落点顺序：屏幕上从上往下，就是这个顺序。
 */
function boundsOf(rows: readonly FeedRow[]): {
  readonly bounds: Map<number, TurnBounds>
  readonly order: readonly number[]
} {
  const bounds = new Map<number, TurnBounds>()
  const order: number[] = []

  for (let at = 0; at < rows.length; at += 1) {
    const row = rows[at]

    if (row === undefined) {
      continue
    }

    const turn = row.item.turn
    const known = bounds.get(turn)

    if (known === undefined) {
      bounds.set(turn, { first: at, last: at, count: 1 })
      order.push(turn)
      continue
    }

    known.last = at
    known.count += 1
  }

  return { bounds, order }
}

/**
 * 这一轮的行下标。
 *
 * 只在界内走，并且逐条核对轮号 —— 不假设一轮的行在数组里连续。
 */
function ownOf(rows: readonly FeedRow[], turn: number, bound: TurnBounds): readonly number[] {
  const own: number[] = []

  for (let at = bound.first; at <= bound.last; at += 1) {
    if (rows[at]?.item.turn === turn) {
      own.push(at)
    }
  }

  return own
}

/**
 * 折一轮：算出要藏起来的行、交给瞬态区的行、封条与它的落点、回复操作与它的落点。
 *
 * 落定的一轮先试复用。判据是四件事同时成立：同一个 span 对象、界一致、界内首尾还是同
 * 一个行对象、人没有改过它的开合。成立时这一轮的每一行都还是同一个对象，结论一律沿用。
 */
function foldOf(
  rows: readonly FeedRow[],
  turn: number,
  span: TurnSpan | undefined,
  bound: TurnBounds | undefined,
  opened: ReadonlySet<number>,
  held: FoldProjection | undefined,
): TurnFold {
  const first = bound?.first ?? -1
  const last = bound?.last ?? -1
  const count = bound?.count ?? 0
  const head = rows[first]
  const foot = rows[last]
  const isOpen = opened.has(turn)
  const settled = span !== undefined && span.endedAt !== undefined
  const kept = held?.folds.get(turn)

  if (
    kept !== undefined &&
    kept.settled &&
    settled &&
    kept.span === span &&
    kept.isOpen === isOpen &&
    kept.first === first &&
    kept.last === last &&
    kept.own.length === count &&
    kept.head === head &&
    kept.foot === foot
  ) {
    return kept
  }

  const own = bound === undefined ? NO_INDEXES : ownOf(rows, turn, bound)
  const running = span !== undefined && span.endedAt === undefined
  const answerAt = latestSpeechIn(rows, own)
  const process = span === undefined ? NO_INDEXES : processIn(rows, own, answerAt, running)
  /* 可点 ⟺ 真有东西可收。什么都没收起时封条只是一行字，不给假按钮。 */
  const hasProcess = process.length > 0
  /* 只有人手动点开才摊开：过程先上屏、回复一到再撤掉，撤掉的那一帧就是内容整段消失
	   又出现。 */
  const hidden = isOpen ? NO_INDEXES : process
  const hiddenSet = hidden.length === 0 ? undefined : new Set(hidden)
  const live: FeedRow[] = []

  if (running) {
    for (const at of hidden) {
      const row = rows[at]

      /* 还在跑、且还没被哪一句话盖过去的那几帧，交给瞬态区。回复不交 —— 它是内容，
			   归转录；被开口盖过的过程也不交 —— 它已经归封条了。 */
      if (at > answerAt && row !== undefined && row.item.type !== 'agent_text') {
        live.push(row)
      }
    }
  }

  /* 秒表量的是整轮：起点是 run_started 落账那一刻，终点是 run_finished / run_failed
	   那一刻 —— 两端都是原生侧盖下的墙钟，与「回复从哪一帧开始流」无关。还在跑的轮次
	   没有终点，封条继续跳字。 */
  const seal: TurnSealPlan | undefined =
    span === undefined
      ? undefined
      : {
          turn,
          startedAt: span.startedAt,
          endedAt: span.endedAt,
          hasProcess,
          isOpen,
        }

  /* 有行可落时，落在这一轮第一条「不是人话、且没被折掉」的行上面：收起时那是回复的
	   首行，摊开时那是第一条过程 —— 两种状态下它都恰在提问与内容之间，不会挪。 */
  const anchorAt =
    seal === undefined
      ? undefined
      : own.find((at) => rows[at]?.item.type !== SAID && hiddenSet?.has(at) !== true)
  const sealAt = anchorAt === undefined ? undefined : rows[anchorAt]?.item.id
  const visibleOwn = hiddenSet === undefined ? own : own.filter((at) => !hiddenSet.has(at))
  const reply = replyIn(rows, visibleOwn, running)

  return {
    span,
    first,
    last,
    head,
    foot,
    isOpen,
    settled,
    own,
    hidden,
    live: live.length === 0 ? NO_FEED_ROWS : live,
    seal,
    sealAt,
    replyAt: reply?.at,
    reply: reply?.plan,
  }
}

/**
 * 这一轮的回复操作：落点是折叠后最后一个可见条目，正文是最后一段连续 AI 发言。
 *
 * 两件事故意分开：最后一条可见内容可能是工具结果或错误记录，但按钮仍应出现在整轮最
 * 下面，复制的仍然只能是 AI 的回答。
 *
 * 正在跑的轮次没有「最终回复」。span 是首选事实来源；流式与执行中标记是无 span 的历史
 * 数据之外的额外保护，防止恢复边界上短暂出现一组过早的按钮。
 *
 * 正文在这里拼一次，随这一轮的结论一起被记住 —— 落定的一轮一辈子只拼一次。此前它在
 * 每一次绘制里为整条对话的每一轮各拼一份完整答案，代价是对话的字节数而不是行数。
 */
function replyIn(
  rows: readonly FeedRow[],
  own: readonly number[],
  running: boolean,
): { readonly at: string; readonly plan: ReplyActionPlan } | undefined {
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

  /* 从最后一段发言的起点向后只收 agent_text：工具调用、计划、报错和权限记录都不进
	   剪贴板。多个连续文本条目之间保留段落边界。 */
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

  if (text.trim().length === 0) {
    return undefined
  }

  const anchorAt = own[own.length - 1]
  const anchor = anchorAt === undefined ? undefined : rows[anchorAt]

  return anchor === undefined ? undefined : { at: anchor.item.id, plan: { text } }
}

/**
 * 最后那一段连续 agent_text 从哪一行开始。倒着走：先找到最后一条回复，再沿着它往前
 * 收拢同一段，撞上第一条不是回复的帧就停。
 *
 * 跳过旁白，也跳过回复后面的过程 —— 后者正是单调的来源：模型说完又去干活时，这里交回
 * 的还是那句话的起点，边界不退。
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
  return own.filter(
    (at) =>
      isFrame(rows, at) && (at < answerAt || (running && rows[at]?.item.type !== 'agent_text')),
  )
}

/** agent 的一帧：人问的那句不是，报错与授权这类旁白也不是。 */
function isFrame(rows: readonly FeedRow[], at: number): boolean {
  const type = rows[at]?.item.type

  return type !== undefined && type !== SAID && !ASIDE.has(type)
}
