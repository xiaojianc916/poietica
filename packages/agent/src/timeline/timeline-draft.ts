/**
 * 转录的草稿。
 *
 * 纯是对外的性质，不是每一步都要复制：写入的那几个入口各取一份可变副本，事件
 * 逐帧写进去，最后封一次版。一次重放因此只分配一次 items —— 每帧一次在一条几千
 * 帧的对话上是 O(N²)，代价直接落在打开会话的那一刻。
 *
 * 这里只管「怎么写」：追加、封口、按 id 定位、开一个新的段。帧里那些字是什么
 * 意思归 acp-projection；哪一趟该开草稿、什么时候开段归 timeline-reducer。
 */

import type { RunStatus } from '@poietica/agent-contract'
import type { TimelineItem, TimelineState, TurnSpan } from './timeline-contract'

export interface Draft {
  status: RunStatus
  readonly items: TimelineItem[]
  /** id → 下标；没人按 id 找过、上一趟也没交下来，就还没有。 */
  index: Map<string, number> | null
  lastSeq: number
  runIndex: number
  /**
   * 那一问的来源是帧。
   *
   * 实时不是：人按下发送的那一刻 appendUserMessage 就把那句话记下了，它是本地
   * 事实；随后 run_started 回报的 prompt 与 agent 回声的 user_message_chunk 都是
   * 同一句话的第二、第三份。回放反过来 —— 本地那条路径走不到，帧是唯一的来源。
   *
   * 两条入口互斥，所以这不是一道去重闸门，而是「这条路上谁说话」。
   */
  saidFromFrames: boolean
  /**
   * 本段那一问已经由录下来的 prompt 落账。
   *
   * 随段重置（openSegment）。它一为真，agent 回声的那一份就不再另立一条：先到的
   * 那一份是人真正敲下的字节，不夹 agent 注入的旁白。agent 装载旧会话时重放的
   * 历史里没有 run_started，它因此恒为假 —— 那条路上回声是唯一的来源。
   */
  promptLanded: boolean
  /** 每一轮的两端。当轮恒是末尾那一条，见 markTurnStart。 */
  readonly spans: TurnSpan[]
}

/**
 * id → 下标，按转录归属。
 *
 * 索引跨趟成立，因为它是 items 的函数而 items 只追加与就地替换：push 追在末尾，
 * sealTail 与那几处 items[position] = … 都不移动既有条目的位置。所以整条对话只
 * 建一次索引，而不是每开一趟草稿重建一遍。
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
    items: state.items.slice(),
    /* items 是一份浅拷贝，下标与原来逐一对应，所以这张表直接接着用。 */
    index,
    lastSeq: state.lastSeq,
    runIndex: state.runIndex,
    /* 实时是默认。回放那两个入口自己声明帧是来源（见 timeline-reducer）。 */
    saidFromFrames: false,
    promptLanded: false,
    /* 复制一层：草稿要能给末尾那一条补上终点，而交出去的那份是只读的。 */
    spans: state.spans.slice(),
  }
}

export function freeze(draft: Draft): TimelineState {
  const state: TimelineState = {
    status: draft.status,
    items: draft.items,
    lastSeq: draft.lastSeq,
    runIndex: draft.runIndex,
    spans: draft.spans,
  }

  /* 这一趟没人按 id 找过，就没有东西要交下去：不为「以后也许会用」凭空建一张表。 */
  if (draft.index !== null) {
    INDEXES.set(state, draft.index)
  }

  return state
}

/** 新的一轮：它的帧从一开始编号，那一问也还没落账，所以两样一起换。 */
export function openSegment(draft: Draft): void {
  draft.lastSeq = 0
  draft.runIndex += 1
  draft.promptLanded = false
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
 * 回放出来的段号是零或负数（最后一轮为 r0），接着说下去开出来的段号为正。
 *
 * 段由先到的那一方开：人先说话，段在 appendUserMessage 那一刻就开了；没有经过
 * 输入框的那些轮次（重连续接、重试）由 run_started 开。两边不会各开一次 —— 帧
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
  sealTail(draft)
  draft.items.push(item)
  draft.index?.set(item.id, draft.items.length - 1)
  markFirstFrame(draft, item)
}

/**
 * 记下这一轮收到第一帧的时刻。
 *
 * 只认末尾那一条 span，与 markTurnStart 同一条规矩：段号只增不减，当轮恒在末尾，
 * 所以这里不查找也不建索引。
 *
 * 报错与授权不算。额度耗尽的密钥也会立刻回一条错，它证明的是请求到过服务端，不是
 * 模型在干活 —— 而屏幕正是靠这一格决定要不要立那块「正在处理」的碑。
 */
function markFirstFrame(draft: Draft, item: TimelineItem): void {
  const open = draft.spans.at(-1)

  if (open === undefined || open.turn !== item.turn || open.firstFrameAt !== undefined) {
    return
  }

  if (!AGENT_FRAME.has(item.type)) {
    return
  }

  draft.spans[draft.spans.length - 1] = { ...open, firstFrameAt: item.at }
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
 * 开一轮的计时。
 *
 * 当轮恒是数组末尾那一条：段号只增不减（openSegment），而调用方在段号换过之后才走
 * 到这里（applyRunEvents 里 beginRun 在 apply 之前）。所以这里不查找、不建索引 ——
 * 认当轮只看末尾那一条的段号。
 *
 * 同一轮里第二帧 run_started 不会再开一条：一轮只有一个起点。
 */
export function markTurnStart(draft: Draft, at: number): void {
  if (draft.spans.at(-1)?.turn === draft.runIndex) {
    return
  }

  draft.spans.push({ turn: draft.runIndex, startedAt: at })
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

  draft.spans[draft.spans.length - 1] = { ...open, endedAt: at }
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
