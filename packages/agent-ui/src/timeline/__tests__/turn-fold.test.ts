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

function idsOf(rows: readonly FeedRow[]): string[] {
  return rows.map((one) => one.item.id)
}

describe('foldFeed', () => {
  it('folds as the answer arrives, without waiting for the turn to end', () => {
    const rows = [said('q', 0, 1_000), thought('t', 0, 2_000), spoke('a', 0, 5_000)]
    const feed = foldFeed(rows, [running(0, 1_000)], new Set())

    expect(idsOf(feed.rows)).toEqual(['q', 'a'])
    expect(feed.seals.get('a')).toEqual({
      turn: 0,
      startedAt: 1_000,
      /* 这一轮还在跑：没有终点，封条继续跳字。 */
      endedAt: undefined,
      hasProcess: true,
      isOpen: false,
    })
  })

  it('keeps everything open while the turn is still working', () => {
    const rows = [said('q', 0, 1_000), thought('t', 0, 2_000)]
    const feed = foldFeed(rows, [running(0, 1_000)], new Set())

    expect(feed.rows).toBe(rows)
    expect(feed.seals.get('t')).toEqual({
      turn: 0,
      startedAt: 1_000,
      endedAt: undefined,
      hasProcess: false,
      isOpen: true,
    })
  })

  it('opens again when process resumes after a first remark', () => {
    const rows = [said('q', 0, 1_000), spoke('a', 0, 2_000), thought('t', 0, 3_000)]
    const feed = foldFeed(rows, [running(0, 1_000)], new Set())

    expect(feed.rows).toBe(rows)
    expect(feed.seals.get('a')?.hasProcess).toBe(false)
  })

  it('honours a turn the reader opened, sealing the first process row', () => {
    const rows = [said('q', 0, 1_000), thought('t', 0, 2_000), spoke('a', 0, 5_000)]
    const feed = foldFeed(rows, [settled(0, 1_000, 9_000)], new Set([0]))

    expect(feed.rows).toBe(rows)
    expect(feed.seals.get('t')?.isOpen).toBe(true)
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

  it('settles the clock on a turn that ended without an answer', () => {
    const rows = [said('q', 0, 1_000), thought('t', 0, 2_000)]
    const feed = foldFeed(rows, [settled(0, 1_000, 4_500)], new Set())

    expect(feed.rows).toBe(rows)
    expect(feed.seals.get('t')).toEqual({
      turn: 0,
      startedAt: 1_000,
      endedAt: 4_500,
      hasProcess: false,
      isOpen: true,
    })
  })

  it('seals a running turn that has not put anything on screen yet', () => {
    /* 生产里的真实形态：思考不上屏（renderable.ts），所以这一轮此刻只有提问那一行 ——
       而它确实在跑，封条归尾部。 */
    const feed = foldFeed([said('q', 0, 1_000)], [running(0, 1_000)], new Set())

    expect(feed.seals.size).toBe(0)
    expect(feed.tail).toEqual({
      turn: 0,
      startedAt: 1_000,
      endedAt: undefined,
      hasProcess: false,
      isOpen: true,
    })
  })

  it('moves the seal onto the first row the turn puts on screen', () => {
    const rows = [said('q', 0, 1_000), spoke('a', 0, 2_000)]
    const feed = foldFeed(rows, [running(0, 1_000)], new Set())

    expect(feed.tail).toBeUndefined()
    expect(feed.seals.get('a')?.endedAt).toBeUndefined()
  })

  it('leaves no seal for a finished turn that never reached the screen', () => {
    const feed = foldFeed([said('q', 0, 1_000)], [settled(0, 1_000, 4_000)], new Set())

    expect(feed.seals.size).toBe(0)
    expect(feed.tail).toBeUndefined()
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
    expect([...feed.seals.keys()]).toEqual(['a0', 'a1'])
  })

  it('leaves an older conversation untouched when no span was recorded', () => {
    const rows = [said('q', 0, 1_000), spoke('a', 0, 2_000)]
    const feed = foldFeed(rows, [], new Set())

    expect(feed.rows).toBe(rows)
    expect(feed.seals.size).toBe(0)
    expect(feed.tail).toBeUndefined()
  })

  it('measures a turn that produced nothing from the moment it began', () => {
    const rows = [said('q', 0, 1_000), broke('e', 0, 7_000)]
    const feed = foldFeed(rows, [settled(0, 1_000, 7_000)], new Set())

    expect(feed.seals.get('e')).toEqual({
      turn: 0,
      startedAt: 1_000,
      endedAt: 7_000,
      hasProcess: false,
      isOpen: true,
    })
  })

  it('measures a pure-answer turn from send to settle, never zero by construction', () => {
    /* 一轮只有一段话时，「第一帧」与「最终回复」本是同一条 —— 起点与终点曾撞在
       同一帧上，耗时恒为 0s。现在两端都取自 span。 */
    const rows = [said('q', 0, 1_000), spoke('a', 0, 2_000)]
    const feed = foldFeed(rows, [settled(0, 1_000, 31_000)], new Set())

    expect(feed.seals.get('a')).toEqual({
      turn: 0,
      startedAt: 1_000,
      endedAt: 31_000,
      hasProcess: false,
      isOpen: false,
    })
  })
})
