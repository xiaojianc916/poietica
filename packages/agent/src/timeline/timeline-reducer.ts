import type { RunEvent } from '@poietica/agent-contract'
import { apply, surelyIgnored } from './projection'
import type { TimelineState } from './timeline-contract'
import type { Draft } from './timeline-draft'
import {
  beginQuestion,
  beginRun,
  draftOf,
  freeze,
  markTurnEnd,
  namespace,
  openSegment,
  push,
  pushBeforeRun,
  sealTail,
} from './timeline-draft'

/**
 * The timeline reducer.
 *
 * Pure, total and replayable: the same events in the same order always produce
 * the same state, and replaying a persisted log must reproduce a live run byte
 * for byte. It performs no IO, holds no clock and touches no module state.
 *
 * The state is a conversation, not a run. A turn is a segment appended to it:
 * appendUserMessage opens the segment the moment the user commits, and the
 * frames of that turn fill it in. Nothing is ever cleared, because a transcript
 * that forgets the previous turn is not a transcript.
 *
 * Sequence numbers are monotonic per session (recorder.rs SeqLine), and entry
 * identities are namespaced by segment: the agent is free to reuse a tool call
 * id, so without that namespace a second turn would write over the first.
 *
 * Tolerances are deliberate, because a transport can misbehave:
 *   - a duplicated seq inside a segment is discarded;
 *   - a tool_call_update for an unknown id creates a placeholder rather than
 *     dropping the update on the floor.
 *
 * 纯是对外的性质，不是每一步都要复制。内部走一份草稿：draftOf 取出可变副本，
 * 事件逐帧写进去，freeze 交出成品（见 timeline-draft）。
 *
 * 这个文件只剩写入的入口：一趟草稿的开合，与开段的时机。段的边界只有调用方
 * 知道（见 apply 开头那段注释），所以它必须留在这一层。
 *
 * 帧里那些字如何变成条目归 projection：一轮的生命周期在那一层，方言在
 * kap-projection。图也在那一帧上，所以它没有第二个去处。
 */

export function createTimelineState(): TimelineState {
  return {
    status: 'idle',
    items: [],
    lastSeq: 0,
    runIndex: 0,
    spans: [],
  }
}

export function replayRunEvents(events: readonly RunEvent[]): TimelineState {
  const draft = draftOf(createTimelineState())

  for (const event of events) {
    apply(draft, event)
  }

  return freeze(draft)
}

/**
 * 最新那一页日志，重放成一份转录。
 *
 * 段号从首轮的 r0 正着数，接着说下去的轮次从它之后继续（openSegment 只加不
 * 减），两侧的条目 id 因此不会撞。更早的页由 prependThreadEvents 接在前面。
 */
export function replayThreadEvents(events: readonly RunEvent[]): TimelineState {
  return freeze(fill(draftOf(createTimelineState()), events))
}

/**
 * 更早的一页日志，接在这份转录的前面。
 *
 * 这一批的段号一律小于现有最小段号，所以既有条目的 id 一个字都不改 —— 虚拟
 * 列表的 key、实测高度与下游三处记忆化因此都不失效。段号不连续无害：全仓对
 * turn 只做比较，不做算术。
 *
 * 下界可证：apply 每帧至多开一段（run_started 走 beginRun，openSegment 把
 * promptLanded 置假，随后的 beginQuestion 开不出第二段），所以帧数就是段数
 * 的上界。
 *
 * status、lastSeq 与 runIndex 说的都是最新那一轮，而它在已加载的那一页里，
 * 所以这里一格都不动 —— 一批更早的帧没有资格宣告当前那一轮的状态。
 */
export function prependThreadEvents(
  state: TimelineState,
  events: readonly RunEvent[],
): TimelineState {
  if (events.length === 0) {
    return state
  }

  const earlier = fill(
    draftOf({ ...createTimelineState(), runIndex: floorTurn(state) - events.length }),
    events,
  )

  return {
    status: state.status,
    items: [...earlier.items, ...state.items],
    lastSeq: state.lastSeq,
    runIndex: state.runIndex,
    spans: [...earlier.spans, ...state.spans],
  }
}

/** 现有条目里最小的那个段号；一条都没有时就是它自己的起点。 */
function floorTurn(state: TimelineState): number {
  return state.items.reduce((least, item) => Math.min(least, item.turn), state.runIndex)
}

/** 把一段日志放进一份草稿。两趟共用，所以两趟看见的段边界一定相同。 */
function fill(draft: Draft, events: readonly RunEvent[]): Draft {
  for (const event of events) {
    if (event.kind === 'run_started') {
      beginRun(draft)
    }

    apply(draft, event)
  }

  /* A run that never reached a terminal event was interrupted (force-kill,
     crash), and that is a fact about the run, not about the calls it made.
     Whatever a tool call was doing when the process died is what the log says
     it was doing; how a stalled call is drawn is the read model's business. */
  if (
    draft.status === 'submitted' ||
    draft.status === 'running' ||
    draft.status === 'cancelling' ||
    draft.status === 'awaiting_permission' ||
    draft.status === 'awaiting_question'
  ) {
    draft.status = 'failed'
  }

  return draft
}

/**
 * Opens a turn with what the user said.
 *
 * The message is a local fact: they typed it, they committed it, and no process,
 * protocol or log has to confirm it before it can be read back. A transport
 * failure must be able to take the answer away without taking the question with
 * it, which is why nothing here waits for a frame.
 *
 * Opening a segment also resets the sequence window: sequence numbers are per
 * session (recorder.rs SeqLine), so a run opening on a fresh session starts
 * over at one.
 */
export function appendUserMessage(
  state: TimelineState,
  text: string,
  at: number,
  /**
   * 这一句一共带了几张图。
   *
   * 只要个数，不要地址：地址要等原生侧把字节落盘之后才发得出，而它随这一轮的
   * run_started 帧回来（见 projection.ts 的 withPrompt）。所以这一刻能知道的
   * 只有「带了几张」，而一句纯图片的话正是靠它才站得住。
   */
  carrying = 0,
): TimelineState {
  const said = text.trim()

  /* 空的是这一句话，不是这一格。只挑了图、没打字，仍然是一句说过的话 ——
     此前这里只看文字，那条消息连转录都进不去：图发出去了，屏幕上没有它。 */
  if (said.length === 0 && carrying === 0) {
    return state
  }

  const draft = draftOf(state)

  /*
   * 又问一句，不等于上一个问题消失了。
   *
   * 此前这里无条件写 'running'。agent 停在一个还没答复的权限请求上时，那一笔
   * 就把「我在等你批准」抹掉了 —— 而那条请求仍然躺在 items 里、resolution 仍
   * 然是 undefined、原生侧的 RunSlot 仍然在阻塞。状态被当成一个可以随手赋值的
   * 共享字段，是这条缺陷的形状：全包七处 status 赋值里，只有这一处不是帧驱动的。
   *
   * 一轮的状态由帧说了算。本地这条路径唯一有资格宣告的是「有一轮在跑」，而
   * 两种 awaiting 本来就是在跑的一种，它比 running 多带一个事实，覆盖它
   * 只会丢信息。
   *
   * 「有没有一轮在跑」同时回答了另一个问题：这一句话开不开一段。没在跑，它就是
   * 新一轮的开头，段在这一刻开；正在跑时插的那句话属于在跑的那一轮 —— 换段会连
   * seq 窗口带 id 前缀一起换掉，在飞的工具调用会认不回自己那张卡。两件事同一个
   * 判据，所以只判一次。
   */
  const busy =
    draft.status === 'submitted' ||
    draft.status === 'running' ||
    draft.status === 'awaiting_permission' ||
    draft.status === 'awaiting_question'

  if (!busy) {
    openSegment(draft)
    draft.status = 'submitted'
  }

  /*
   * 这句话开的段就是它自己那一轮：随后的 run_started 看见这一段还没收过帧，不会
   * 再开一段。此前它落在上一段，而回放那边同一句话由 run_started 的 prompt 投影
   * 出来、落在它自己那一轮里 —— 同一条对话读两遍给出两种归属，与这个文件开篇那条
   * 「回放逐字复现实时」相抵触。位置补进 id，同一段内问两次也不会撞。
   *
   * 前缀是 local-said- 而不是 said-：said- 是帧那边在用的，号源是段内 seq；这里
   * 的号源是整条对话的长度。两个号源共用一个前缀，只要回放出来的条目数恰好等于
   * 那一帧的 seq 就会撞出同一个 id —— 一段只有 prompt、没有任何产出的日志（断网
   * 就是这样）正好满足：items 长度 1，seq 也是 1。撞出来的后果是虚拟列表拿到重复
   * key，行复用错乱。
   */
  beginQuestion(draft)
  pushBeforeRun(draft, {
    type: 'user_message',
    id: `${namespace(draft)}local-said-${String(draft.items.length)}`,
    turn: draft.runIndex,
    at,
    text: said,
  })

  return freeze(draft)
}

/**
 * 记一件本地发生的事故。
 *
 * 起不来的 agent、送不出去的权限答复、读不回来的历史 —— 它们发生在任何一帧
 * 之前或之外，日志里没有对应的帧。此前调用方伪造一帧 run_failed 交给
 * applyRunEvent，序号取 lastSeq 加一；而序号是原生那侧发的（recorder.rs 的
 * SeqLine，按会话单调），客户端自己发一个就是替对面占了一个号：真的那一帧
 * 带着同一个号到达时，会被上面那道去重判成重复而永久丢弃。
 *
 * 所以本地的事故以本地的形式进来：一条 error 条目，不占序号、不动 lastSeq 窗口、
 * 不冒充任何一帧。它因此也不参与重放 —— 一段日志放两遍仍然得到同一个状态，那是
 * 回放能被信任的前提，而一件只发生在这台机器上的事故本来就不在日志里。
 *
 * endsTurn 是一个事实，不是一个开关：问送不出去，这一轮就到此为止；答复送不出去
 * 或历史读不回来时，那一轮还在跑，谁也没资格替它宣告失败。
 */
export function appendLocalError(
  state: TimelineState,
  error: { readonly message: string; readonly at: number; readonly endsTurn: boolean },
): TimelineState {
  const draft = draftOf(state)

  if (error.endsTurn) {
    draft.status = 'failed'
  }

  /* 位置补进 id，前缀与另一条本地路径成对：local- 之下再分种类，才不会与帧那边
     按 seq 编号的 error- / agent- 共用同一个号段。 */
  push(draft, {
    type: 'error',
    id: `${namespace(draft)}local-error-${String(draft.items.length)}`,
    turn: draft.runIndex,
    at: error.at,
    message: error.message,
  })

  return freeze(draft)
}

function canCancel(status: TimelineState['status']): boolean {
  return (
    status === 'submitted' ||
    status === 'running' ||
    status === 'awaiting_permission' ||
    status === 'awaiting_question'
  )
}

/** Records user intent without pretending that the server has stopped. */
export function requestRunCancellation(state: TimelineState): TimelineState {
  if (!canCancel(state.status)) {
    return state
  }

  const draft = draftOf(state)

  sealTail(draft)
  draft.status = 'cancelling'

  return freeze(draft)
}

/** Closes a cancellation after KAP accepts it or the local deadline expires. */
export function rejectRunCancellation(state: TimelineState): TimelineState {
  if (state.status !== 'cancelling') {
    return state
  }

  const draft = draftOf(state)

  draft.status = 'running'

  return freeze(draft)
}

export function confirmRunCancellation(state: TimelineState, at: number): TimelineState {
  if (state.status === 'cancelled' || (!canCancel(state.status) && state.status !== 'cancelling')) {
    return state
  }

  const draft = draftOf(state)

  sealTail(draft)
  draft.status = 'cancelled'
  markTurnEnd(draft, at)

  return freeze(draft)
}

/**
 * 一批帧，一趟草稿。
 *
 * 逐帧调用会为每一帧复制一次整条 items —— 一次回答几千帧，那是 O(帧 × 条目)，
 * 而屏幕一秒只画六十次：中间那些副本没有一个被人看见过。上游按屏幕的节拍把帧
 * 攒起来，攒到的这一批在这里合成一次复制、一次封版。
 *
 * 判据一个字没改，只是共用一份草稿：草稿自己带着 lastSeq，同一批里的重复帧
 * 照样被丢掉。一批全是重复帧时原样交回入参那个对象 —— 引用不变，下游的记忆化
 * 不会被白白打掉，这正是此前那道提前返回守着的东西。
 */
export function applyRunEvents(state: TimelineState, events: readonly RunEvent[]): TimelineState {
  let draft: Draft | null = null

  for (const event of events) {
    /* 一批全是重复帧时不开草稿，原样把入参那个对象交回去。判据不在这里写第二
       遍 —— surelyIgnored 与真正的那道闸门住在同一个文件里，它只做单向承诺：
       为真则一定会被丢掉。 */
    if (surelyIgnored(event, draft?.lastSeq ?? state.lastSeq)) {
      continue
    }

    draft ??= draftOf(state)

    /* 实时流不会把旧帧再送一遍，所以这里的 run_started 一定是新的一轮。号按
       会话编（recorder.rs 的 SeqLine），重连之后是另一条会话、从一起编，窗口
       必须跟着换，否则整轮会被上一轮的 seq 判成重复——没有经过输入框的那些轮次
       （重连续接、重试）就是这么消失的。人先说话的那些轮次里段已经开过了，
       beginRun 认得出来，不会再开一段。 */
    if (event.kind === 'run_started') {
      beginRun(draft)
    }

    apply(draft, event)
  }

  return draft === null ? state : freeze(draft)
}

/** 一帧就是一批只有一帧的批。两条路径共用同一套判据，不是两份实现。 */
export function applyRunEvent(state: TimelineState, event: RunEvent): TimelineState {
  return applyRunEvents(state, [event])
}
