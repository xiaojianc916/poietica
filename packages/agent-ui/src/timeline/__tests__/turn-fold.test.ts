import type { FeedRow, TurnSpan } from '@poietica/agent'
import { describe, expect, it } from 'vitest'
import { foldFeed } from '../turn-fold'

function row(item: FeedRow['item']): FeedRow {
  return { item, isStreamingTail: false, isInFlight: false }
}

function said(id: string, turn: number, at: number): FeedRow {
  return row({ type: 'user_message', id, turn, at, text: '问一句' })
}

function thought(id: string, turn: number, at: number): FeedRow {
  return row({ type: 'agent_thought', id, turn, at, text: '想一下', sealed: true })
}

function spoke(id: string, turn: number, at: number): FeedRow {
  return row({ type: 'agent_text', id, turn, at, text: '答一句', sealed: true })
}

function broke(id: string, turn: number, at: number): FeedRow {
  return row({ type: 'error', id, turn, at, message: '断了' })
}

function settled(turn: number, startedAt: number, endedAt: number): TurnSpan {
  return { turn, startedAt, endedAt }
}

function running(turn: number, startedAt: number): TurnSpan {
  return { turn, startedAt }
}

function heard(turn: number, startedAt: number, firstFrameAt: number): TurnSpan {
  return { turn, startedAt, firstFrameAt }
}

function idsOf(rows: readonly FeedRow[]): string[] {
  return rows.map((one) => one.item.id)
}

describe('foldFeed', () => {
  it('folds as the answer arrives, without waiting for the turn to end', () => {
    const rows = [said('q', 0, 1_000), thought('t', 0, 2_000), spoke('a', 0, 5_000)]
    const feed = foldFeed(rows, [running(0, 1_000)], new Set())

    expect(idsOf(feed.rows)).toEqual(['q', 'a'])
    /* 封条挂在提问那一行，渲染在它之后 —— 收起摊开都不挪。 */
    expect(feed.seals.get('q')).toEqual({
      turn: 0,
      startedAt: 1_000,
      /* 这一轮还在跑：没有终点，封条继续跳字。 */
      endedAt: undefined,
      hasProcess: true,
      isOpen: false,
    })
    expect(feed.seals.get('a')).toBeUndefined()
  })

  it('routes the process of a working turn to the transient channel', () => {
    /* 过程从出生就不在转录里：它不可能先上屏再被撤掉，而那次撤销正是「前面的内容
       整段消失又出现」的成因。它去尾部那块瞬态区，随轮次一起收走。 */
    const rows = [said('q', 0, 1_000), thought('t', 0, 2_000)]
    const feed = foldFeed(rows, [heard(0, 1_000, 1_500)], new Set())

    expect(idsOf(feed.rows)).toEqual(['q'])
    expect(idsOf(feed.live)).toEqual(['t'])
    expect(feed.seals.get('q')?.hasProcess).toBe(true)
  })

  it('never takes a row off the transcript while the turn is still working', () => {
    /* 一轮之内转录只追加。过程从出生就不在 rows 里，所以不存在「先上屏、再被移出数
       组」这一步 —— 而那一步正是虚拟器整表重新落位、屏幕上内容整段消失又出现的成因。
       这里把同一轮逐帧走一遍，断言的是整条序列，而不是某一个终局。 */
    const span = [running(0, 1_000)]
    const q = said('q', 0, 1_000)
    const t0 = thought('t0', 0, 2_000)
    const t1 = thought('t1', 0, 3_000)
    const a = spoke('a', 0, 4_000)

    const seen = [[q], [q, t0], [q, t0, t1], [q, t0, t1, a]].map((rows) =>
      idsOf(foldFeed(rows, span, new Set()).rows),
    )

    expect(seen).toEqual([['q'], ['q'], ['q'], ['q', 'a']])
  })

  it('keeps the fold where it is when process resumes after a remark', () => {
    /* 说一句、再去干活：边界停在那句话上不退回去，已经收起的东西不会弹回屏幕，
       封条也就不会从提问那一行挪走。 */
    const rows = [
      said('q', 0, 1_000),
      thought('t0', 0, 2_000),
      spoke('a', 0, 3_000),
      thought('t1', 0, 4_000),
    ]
    const feed = foldFeed(rows, [running(0, 1_000)], new Set())

    expect(idsOf(feed.rows)).toEqual(['q', 'a'])
    /* t0 已经被那句话盖过去了，它归封条；t1 是当下这一段工作，它归瞬态区。 */
    expect(idsOf(feed.live)).toEqual(['t1'])
    expect(feed.seals.get('q')?.hasProcess).toBe(true)
  })

  it('honours a turn the reader opened', () => {
    const rows = [said('q', 0, 1_000), thought('t', 0, 2_000), spoke('a', 0, 5_000)]
    const feed = foldFeed(rows, [settled(0, 1_000, 9_000)], new Set([0]))

    expect(feed.rows).toBe(rows)
    expect(feed.seals.get('q')?.isOpen).toBe(true)
    expect(feed.seals.get('t')).toBeUndefined()
    expect(feed.seals.get('a')).toBeUndefined()
  })

  it('never folds an aside, and reads past it to find the answer', () => {
    const rows = [
      said('q', 0, 1_000),
      thought('t', 0, 2_000),
      spoke('a', 0, 5_000),
      broke('e', 0, 6_000),
    ]
    const feed = foldFeed(rows, [settled(0, 1_000, 9_000)], new Set())

    expect(idsOf(feed.rows)).toEqual(['q', 'a', 'e'])
  })

  it('empties the transient channel once the turn has settled', () => {
    const rows = [said('q', 0, 1_000), thought('t', 0, 2_000), spoke('a', 0, 5_000)]
    const feed = foldFeed(rows, [settled(0, 1_000, 9_000)], new Set())

    expect(feed.live).toHaveLength(0)
    expect(idsOf(feed.rows)).toEqual(['q', 'a'])
  })

  it('settles the clock on a turn that ended without an answer', () => {
    const rows = [said('q', 0, 1_000), thought('t', 0, 2_000)]
    const feed = foldFeed(rows, [settled(0, 1_000, 4_500)], new Set())

    expect(feed.rows).toBe(rows)
    expect(feed.seals.get('q')).toEqual({
      turn: 0,
      startedAt: 1_000,
      endedAt: 4_500,
      hasProcess: false,
      isOpen: false,
    })
  })

  it('holds the seal back until the turn has actually heard something', () => {
    /* 请求出去了，模型一帧都没回过（额度耗尽、端点连不上）：这时候只该有等待指示器，
       立一块「正在处理」等于替一个还没回过话的请求作证。 */
    const feed = foldFeed([said('q', 0, 1_000)], [running(0, 1_000)], new Set())

    expect(feed.seals.size).toBe(0)
  })

  it('seals a running turn that heard a frame but put nothing on screen yet', () => {
    /* 生产里的真实形态：思考不上屏（renderable.ts），所以这一轮此刻只有提问那一行 ——
       而它确实在跑（firstFrameAt 已盖），封条挂在提问上。 */
    const feed = foldFeed([said('q', 0, 1_000)], [heard(0, 1_000, 1_200)], new Set())

    expect(feed.seals.get('q')).toEqual({
      turn: 0,
      startedAt: 1_000,
      endedAt: undefined,
      hasProcess: false,
      isOpen: false,
    })
  })

  it('keeps the seal on the question row while the turn runs', () => {
    const rows = [said('q', 0, 1_000), spoke('a', 0, 2_000)]
    const feed = foldFeed(rows, [running(0, 1_000)], new Set())

    expect(feed.seals.get('q')?.endedAt).toBeUndefined()
    expect(feed.seals.get('a')).toBeUndefined()
  })

  it('leaves no seal for a finished turn that never reached the screen', () => {
    const feed = foldFeed([said('q', 0, 1_000)], [settled(0, 1_000, 4_000)], new Set())

    expect(feed.seals.size).toBe(0)
  })

  it('gives every turn its own seal', () => {
    const rows = [
      said('q0', 0, 1_000),
      thought('t0', 0, 2_000),
      spoke('a0', 0, 3_000),
      said('q1', 1, 4_000),
      thought('t1', 1, 5_000),
      spoke('a1', 1, 6_000),
    ]
    const feed = foldFeed(rows, [settled(0, 1_000, 3_500), running(1, 4_000)], new Set())

    expect(idsOf(feed.rows)).toEqual(['q0', 'a0', 'q1', 'a1'])
    expect([...feed.seals.keys()]).toEqual(['q0', 'q1'])
  })

  it('leaves an older conversation untouched when no span was recorded', () => {
    const rows = [said('q', 0, 1_000), spoke('a', 0, 2_000)]
    const feed = foldFeed(rows, [], new Set())

    expect(feed.rows).toBe(rows)
    expect(feed.seals.size).toBe(0)
  })

  it('measures a turn that produced nothing from the moment it began', () => {
    /* 只有一行报错也算有过内容：落定后一行都没有才是空碑，这里不立。 */
    const rows = [said('q', 0, 1_000), broke('e', 0, 7_000)]
    const feed = foldFeed(rows, [settled(0, 1_000, 7_000)], new Set())

    expect(feed.seals.get('q')).toEqual({
      turn: 0,
      startedAt: 1_000,
      endedAt: 7_000,
      hasProcess: false,
      isOpen: false,
    })
  })

  it('measures a pure-answer turn from send to settle, never zero by construction', () => {
    /* 一轮只有一段话时，「第一帧」与「最终回复」本是同一条 —— 起点与终点曾撞在
       同一帧上，耗时恒为 0s。现在两端都取自 span。 */
    const rows = [said('q', 0, 1_000), spoke('a', 0, 2_000)]
    const feed = foldFeed(rows, [settled(0, 1_000, 31_000)], new Set())

    expect(feed.seals.get('q')).toEqual({
      turn: 0,
      startedAt: 1_000,
      endedAt: 31_000,
      hasProcess: false,
      isOpen: false,
    })
  })

  it('anchors reply actions after the final visible row of a settled turn', () => {
    /*
     * 这正是此前出错的形态：AI 先说一句，随后继续做事。
     *
     * agent_text 不是轮次末端，所以操作区不能挂在 a 上；整轮最后一个可见条目
     * 是 after，操作区只能在那里出现一次。
     */
    const rows = [said('q', 0, 1_000), spoke('a', 0, 2_000), thought('after', 0, 3_000)]
    const feed = foldFeed(rows, [settled(0, 1_000, 4_000)], new Set())

    expect([...feed.replyActions.keys()]).toEqual(['after'])
    expect(feed.replyActions.get('after')).toEqual({ text: '答一句' })
    expect(feed.replyActions.get('a')).toBeUndefined()
  })

  it('does not expose reply actions before the turn has settled', () => {
    const rows = [said('q', 0, 1_000), spoke('a', 0, 2_000)]
    const feed = foldFeed(rows, [running(0, 1_000)], new Set())

    expect(feed.replyActions.size).toBe(0)
  })

  it('gives a settled turn exactly one reply action', () => {
    const rows = [
      said('q', 0, 1_000),
      spoke('early', 0, 2_000),
      thought('work', 0, 3_000),
      spoke('final', 0, 4_000),
    ]
    const feed = foldFeed(rows, [settled(0, 1_000, 5_000)], new Set())

    expect(feed.replyActions.size).toBe(1)
    expect(feed.replyActions.get('final')).toEqual({ text: '答一句' })
    expect(feed.replyActions.get('early')).toBeUndefined()
  })
})
