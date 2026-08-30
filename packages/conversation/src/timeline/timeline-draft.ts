/**
 * 转录的草稿。
 *
 * 纯是对外的性质，不是每一步都要复制：写入的那几个入口各取一份可变副本，事件
 * 逐帧写进去，最后封一次版。复制只发生在活动段上：已封口的段跨帧按引用共享，代价
 * 因此只与这一轮的长度相关。
 *
 * 这里只管「怎么写」：追加、封口、按 id 定位、开一个新的段。帧里那些字是什么
 * 意思归 kap-projection；哪一趟该开草稿、什么时候开段归 timeline-reducer。
 */

import type { RunStatus } from '../agent'
import type {
  AgentTextItem,
  AgentThoughtItem,
  ErrorItem,
  TimelineItem,
  TimelineState,
  TurnPage,
  TurnSpan,
  UserMessageItem,
} from './timeline-contract'

export interface Draft {
  status: RunStatus
  /** 已封口的段：只在换段时追加。 */
  sealed: readonly TurnPage[]
  /** 活动段的条目。写入只发生在这里。 */
  items: TimelineItem[]
  /** id → 下标；没人按 id 找过、上一趟也没交下来，就还没有。 */
  index: Map<string, number> | null
  lastSeq: number
  runIndex: number
  /**
   * 本段已经有过一问。
   *
   * 随段重置（openSegment），每落一问置真（beginQuestion）。一轮从一问开始，所以
   * 下一问到达时它就是「该换段了」—— 回放靠它一趟把段划对，不再事后倒着补。
   *
   * 与 dressTail 问的不是同一件事：那一条问「紧挨着的上一条是不是这一问」，用来
   * 认出同一句话的回声；这一格问「这一段有没有过问」，跨得过中间的产出。
   */
  promptLanded: boolean
  /** 每一轮的两端。当轮恒是末尾那一条，见 markTurnStart。 */
  spans: readonly TurnSpan[]
  spansOwned: boolean
}

/**
 * id → 下标，按转录归属。
 *
 * 索引跨趟成立，因为它是 items 的函数而 items 只追加与就地替换：push 追在末尾，
 * sealTail 与那几处 items[position] = … 都不移动既有条目的位置。所以活动段的索引跨趟成立，
 * 换段时随之作废。
 *
 * 所有权是线性的：draftOf 取走，freeze 交给新的那一份状态，旧状态因此不再持有
 * 它。一份状态被开两次草稿（回退、分叉）时第二次从零重建 —— 宁可慢一次，也不让
 * 两趟草稿往同一张表里写。弱引用是这份缓存的边界：状态被回收，索引跟着走。
 */
const INDEXES = new WeakMap<TimelineState, Map<string, number>>()

export function draftOf(state: TimelineState): Draft {
  const index = INDEXES.get(state) ?? null

  /* 取走就不再属于它：一份状态最多把索引交出去一次。 */
  INDEXES.delete(state)

  return {
    status: state.status,
    sealed: state.sealed,
    items: state.active.items.slice(),
    /* 活动段是一份浅拷贝，下标与原来逐一对应，所以这张表直接接着用。 */
    index,
    lastSeq: state.lastSeq,
    runIndex: state.active.turn,
    promptLanded: false,
    spans: state.spans,
    spansOwned: false,
  }
}

function writableSpans(draft: Draft): TurnSpan[] {
  if (!draft.spansOwned) {
    draft.spans = draft.spans.slice()
    draft.spansOwned = true
  }
  return draft.spans as TurnSpan[]
}

/** 落定的三种结局。 */
const SETTLED: ReadonlySet<RunStatus> = new Set(['cancelled', 'completed', 'failed'])

export function freeze(draft: Draft): TimelineState {
  /* 轮次的终点由状态说了算，不由某一帧说了算：终帧没到过的运行（进程被杀、连接断）
     同样要收口，否则封条会永远停在「正在处理」。 */
  if (SETTLED.has(draft.status)) {
    const open = draft.spans.at(-1)

    if (open?.lastFrameAt !== undefined) {
      markTurnEnd(draft, open.lastFrameAt)
    }
  }

  const state: TimelineState = {
    status: draft.status,
    sealed: draft.sealed,
    active: { turn: draft.runIndex, items: draft.items },
    lastSeq: draft.lastSeq,
    spans: draft.spans,
  }

  /* 这一趟没人按 id 找过，就没有东西要交下去：不为「以后也许会用」凭空建一张表。 */
  if (draft.index !== null) {
    INDEXES.set(state, draft.index)
  }

  return state
}

/**
 * 新的一轮：上一段就此封口，帧从一开始编号，那一问也还没落账。
 *
 * 空段不封：一轮的存在由 spans 记，没有条目的段只会在派生里占一个空位。
 */
export function openSegment(draft: Draft): void {
  if (draft.items.length > 0) {
    draft.sealed = [...draft.sealed, { turn: draft.runIndex, items: draft.items }]
  }

  draft.items = []
  draft.index = null
  draft.lastSeq = 0
  draft.runIndex += 1
  draft.promptLanded = false
}

/**
 * 取走上一段末尾那条还没等到 prompt_admitted 的提问。
 *
 * 它属于新的一段：认领之后它与自己的答复同段且相邻。活动段里的那一条不算 —— 那是
 * 本段自己的开头。
 */
export function takeQueued(draft: Draft, prompt: string): UserMessageItem | undefined {
  if (queuedAt(draft.items) >= 0) {
    return undefined
  }

  const page = draft.sealed.at(-1)

  if (page === undefined) {
    return undefined
  }

  const at = queuedAt(page.items)
  const queued = at < 0 ? undefined : page.items[at]

  if (queued?.type !== 'user_message' || queued.text !== prompt) {
    return undefined
  }

  const kept = page.items.slice()

  kept.splice(at, 1)
  draft.sealed = [...draft.sealed.slice(0, -1), { turn: page.turn, items: kept }]

  return queued
}

/** 末尾那条本机落账、还没被认领的提问。 */
function queuedAt(items: readonly TimelineItem[]): number {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]

    if (item?.type === 'user_message' && item.id.includes('local-said-')) {
      return index
    }
  }

  return -1
}

/**
 * 又一问，就是又一轮。
 *
 * 问有三条到达路 —— 人经输入框提交的、日志里录下的 prompt、agent 回声的 chunk ——
 * 落账之前都过这里。判据因此只有一条：本段已经有过问，这一句就属于下一轮。
 *
 * 实时那一侧的开段由 appendUserMessage 与 beginRun 各自的时机决定（一个知道人有
 * 没有在等答复，一个知道 seq 窗口该不该换），这里不越过它们：它们开过之后
 * promptLanded 恒为假，这一句只落账、不再开一段。
 */
export function beginQuestion(draft: Draft): void {
  if (draft.promptLanded) {
    openSegment(draft)
  }

  draft.promptLanded = true
}

/**
 * 一轮的帧开始到了。
 *
 * 段可能已经开过：人先说话时开段的是 appendUserMessage —— 那一句话就是这一轮的
 * 开头，它和随后的帧本来就该同号。「这一段还没收过帧」就是「它刚被开出来」，所以
 * 不必另记一个标志位，lastSeq 为零说的就是这件事。
 *
 * 没有经过输入框的那些轮次（重连续接、重试）到这里时，lastSeq 还停在上一轮的窗口
 * 上，于是照常开一段 —— 否则整轮会被上一轮的 seq 判成重复而逐帧丢掉。
 */
export function beginRun(draft: Draft): void {
  if (draft.lastSeq === 0) {
    return
  }

  openSegment(draft)
}

/**
 * The identity prefix of the turn currently being written.
 *
 * 段号从首轮的 r0 起只增不减（openSegment），回放与接着说下去共用这一条数法。
 *
 * 段由先到的那一方开：人先说话，段在 appendUserMessage 那一刻就开了；没有经过
 * 输入框的那些轮次（重连续接、重试）由 prompt_admitted 开。两边不会各开一次 —— 帧
 * 那侧走 beginRun，它只在这一段已经收过帧时才开新的一段。人说的那句话因此与它
 * 的答复同号，实时与回放对同一条对话给出同一种归属。
 *
 * 本地那两条路径的号源是整条对话的长度，与帧那边按 seq 编的号不是一回事，所以
 * 前缀是 local- 开头的，与协议发的号彻底隔开：共用前缀时，一段只有 prompt、没有
 * 任何产出的日志（断网就是这样）正好让两个号源撞出同一个 id。
 */
export function namespace(draft: Draft): string {
  return `r${String(draft.runIndex)}-`
}

/** 模型真的在干活的证据：这几种帧只可能由它那一侧产生。 */
const AGENT_FRAME: ReadonlySet<TimelineItem['type']> = new Set([
  'agent_text',
  'agent_thought',
  'plan',
  'tool_call',
])

/** 追加一条：末尾那段说到这里为止，新的一条排在它后面。 */
export function push(draft: Draft, item: TimelineItem): void {
  openSpan(draft)
  append(draft, item)
  markAgentActive(draft, item)
}

/**
 * 记下这一轮的一次失败。
 *
 * 同一次失败会从两条通道各说一遍：kap 的 error 事件，与 turn.ended 携带的
 * error。落账因此只有这一处，判据是「这一轮的上一条就是同一句话」—— 重复的
 * 交代不占第二行，两次不同的失败照旧都留下。
 */
export function pushFailure(draft: Draft, failure: ErrorItem): void {
  const tail = draft.items.at(-1)

  if (tail?.type === 'error' && tail.turn === failure.turn && tail.message === failure.message) {
    return
  }

  push(draft, failure)
}

/**
 * Appends a local question before its run has produced a frame.
 *
 * A span records a run observed in the event log. Merely committing a local
 * question must not manufacture one: the subsequent prompt_admitted frame creates
 * and timestamps it, while a question whose run never started remains outside
 * the span ledger.
 */
export function pushBeforeRun(draft: Draft, item: TimelineItem): void {
  append(draft, item)
}

function append(draft: Draft, item: TimelineItem): void {
  sealTail(draft)
  draft.items.push(item)
  draft.index?.set(item.id, draft.items.length - 1)
}

/**
 * 一段收下第一条，它就存在了。
 *
 * 段的存在与它的两端是两件事：本机帧日志之前的旧对话没有 prompt_admitted，一轮的起止
 * 时刻因此无从谈起，但那些轮次确实发生过 —— 封条要靠 spans 才认得出「已处理」。
 * 所以这里只立一条空的：有几轮是数得出来的，几点开始的不是。两端由 markTurnStart
 * 与 markTurnEnd 在 prompt_admitted 与终帧到达时盖上。
 */
function openSpan(draft: Draft): void {
  if (draft.spans.at(-1)?.turn === draft.runIndex) {
    return
  }

  writableSpans(draft).push({ turn: draft.runIndex })
}

/**
 * 模型开口了。
 *
 * 报错与授权不算：额度耗尽的密钥也会立刻回一条错，它证明的只是请求到过服务端。
 */
function markAgentActive(draft: Draft, item: TimelineItem): void {
  if (draft.status !== 'submitted' || !AGENT_FRAME.has(item.type)) {
    return
  }

  draft.status = 'running'
}

/**
 * 这一轮又活了一下。
 *
 * 运行中的耗时以它为终点，所以两端同在日志域。每一帧都盖 —— 一段正在写的回答同样是
 * 活着的证据，计时不该在它写字的时候停住。
 */
export function markFrame(draft: Draft, at: number): void {
  openSpan(draft)

  const spans = writableSpans(draft)
  const open = spans[spans.length - 1]

  if (open === undefined) {
    return
  }

  spans[spans.length - 1] = { ...open, lastFrameAt: at }
}

export function sealTail(draft: Draft): void {
  const tail = draft.items.at(-1)

  if (!tail) {
    return
  }

  if (tail.type !== 'agent_text' && tail.type !== 'agent_thought') {
    return
  }

  if (tail.sealed) {
    return
  }

  draft.items[draft.items.length - 1] = { ...tail, sealed: true }
}

/**
 * 记下一轮的起点。
 *
 * 当轮恒是数组末尾那一条：段号只增不减（openSegment），而这一段一收到条目就先
 * 立好了自己那一条（openSpan）。所以这里不查找、不建索引 —— 认当轮只看末尾。
 *
 * 立没立过都要能落笔：人先说话的那些轮次，段在 appendUserMessage 那一刻就随第一
 * 条条目立起来了，起点要补进那一条；没有经过输入框的那些轮次到这里时它还不在。
 *
 * 记下就不再移动。同一轮里第二帧 prompt_admitted 因此改不了它的起点：一轮只有一个
 * 起点。
 */
export function markTurnStart(draft: Draft, at: number): void {
  const open = draft.spans.at(-1)

  if (open === undefined || open.turn !== draft.runIndex) {
    writableSpans(draft).push({ turn: draft.runIndex, startedAt: at })

    return
  }

  if (open.startedAt !== undefined) {
    return
  }

  const spans = writableSpans(draft)
  spans[spans.length - 1] = { ...open, startedAt: at }
}

/**
 * 给当轮收口。
 *
 * 落定过的不再改：先 run_failed、后面又补一帧 run_finished 时，屏幕上的耗时不该往后
 * 跳。一段还没开过就到了终点的日志这里什么都不做 —— 没有起点就算不出耗时，不画比画
 * 一个 0s 诚实。
 */
export function markTurnEnd(draft: Draft, at: number): void {
  const open = draft.spans.at(-1)

  if (open === undefined || open.endedAt !== undefined) {
    return
  }

  const spans = writableSpans(draft)
  spans[spans.length - 1] = { ...open, endedAt: at }
}

/**
 * 按 id 找一条：索引只有在真的要对账时才建，一次草稿至多建一次。
 *
 * 纯文本流从不走这里，所以流式追加不需要为索引付任何代价。
 */
export function positionOf(draft: Draft, id: string): number {
  let index = draft.index

  if (index === null) {
    index = new Map<string, number>()

    for (const [position, item] of draft.items.entries()) {
      index.set(item.id, position)
    }

    draft.index = index
  }

  return index.get(id) ?? -1
}

/**
 * 把一段流式文本并进它所属的那一条消息。
 *
 * 边界曾经是遍历顺序的副产品：末尾那条同类型、还没封口，就接着往上贴。于是
 * agent 背靠背发两条消息、中间什么都没插时，两条会粘成一条。
 *
 * 所以边界由消息身份说了算：身份变了就是另一条消息，哪怕它紧挨着上一段。身份
 * 怎么算是方言的事，归 kap-projection —— 而「接着写还是新起
 * 一条」是草稿的写法，只有这一份。
 *
 * 它只会切，不会合。中间隔着一张工具卡片的两段，即使同号也仍然是两条：时间轴
 * 记的是发生的顺序，为了让同号的两段并拢而跨过中间那张卡片，就是在改写这个顺序。
 *
 * 身份缺席时退回相邻续写，逐字保持原行为：messageId 在协议帧里本来就
 * 是可选的，client 必须能处理它不在的情况。
 */
export function appendChunk(
  draft: Draft,
  type: 'agent_text' | 'agent_thought',
  chunk: {
    readonly at: number
    /** 新起一条时用的条目 id；接着写时用不上。 */
    readonly id: string
    /** 这一段属于哪一条消息；方言算出来，缺席就不表态。 */
    readonly message?: string | undefined
    readonly text: string
  },
): void {
  const tail = draft.items.at(-1)

  if (tail && tail.type === type && !tail.sealed && sameMessage(tail, chunk.message)) {
    const grown: AgentTextItem | AgentThoughtItem = { ...tail, text: tail.text + chunk.text }

    draft.items[draft.items.length - 1] = grown

    return
  }

  push(draft, {
    type,
    id: chunk.id,
    turn: draft.runIndex,
    at: chunk.at,
    text: chunk.text,
    sealed: false,
    /* 缺席和「值为 undefined」在 exactOptionalPropertyTypes 下不是一回事。 */
    ...(chunk.message === undefined ? {} : { messageId: chunk.message }),
  } as AgentTextItem | AgentThoughtItem)
}

/** 身份缺席时不表态，退回相邻续写；身份在，就必须是同一个。 */
function sameMessage(tail: AgentTextItem | AgentThoughtItem, message: string | undefined): boolean {
  return message === undefined || message === tail.messageId
}
