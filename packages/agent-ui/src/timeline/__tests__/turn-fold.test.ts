import type { FeedRow, TimelineItem, TurnSpan } from '@poietica/agent'
import { describe, expect, it } from 'vitest'
import { foldFeed } from '../turn-fold'

/*
 * 折叠的七条不变量，逐条钉住。
 *
 * 这里面有一条是上一版最贵的教训：一轮以过程收尾时一个字都不许折。当时的判据从末尾
 * 倒扫、撞上工具就返回「没有回复」，而随后那一步把「不是回复」当成「都是过程」，于是
 * 整轮输出连正文一起被折进一行。
 */

const row = (item: TimelineItem): FeedRow => ({
  item,
  isStreamingTail: false,
  isInFlight: false,
})

const said = (id: string, turn = 0): TimelineItem => ({
  type: 'user_message',
  id,
  turn,
  at: 0,
  text: '把 README 里的构建命令核对一遍',
})

const thought = (id: string, turn = 0): TimelineItem => ({
  type: 'agent_thought',
  id,
  turn,
  at: 0,
  text: '先读 README，再与 package.json 对照。',
  sealed: true,
})

const spoke = (id: string, text: string, turn = 0): TimelineItem => ({
  type: 'agent_text',
  id,
  turn,
  at: 0,
  text,
  sealed: true,
})

const broke = (id: string, turn = 0): TimelineItem => ({
  type: 'error',
  id,
  turn,
  at: 0,
  message: '答复送不出去',
})

const settled: readonly TurnSpan[] = [{ turn: 0, startedAt: 1_000, endedAt: 89_000 }]
const running: readonly TurnSpan[] = [{ turn: 0, startedAt: 1_000 }]

const idsOf = (rows: readonly FeedRow[]): readonly string[] => rows.map((row) => row.item.id)

describe('folding a settled turn', () => {
  it('leaves the question, the seal and the answer', () => {
    const rows = [row(said('q')), row(thought('t')), row(spoke('a', '构建命令与 scripts 一致。'))]
    const feed = foldFeed(rows, settled, new Set<number>())

    expect(idsOf(feed.rows)).toEqual(['q', 'a'])
    expect(feed.seals.get('a')).toEqual({
      turn: 0,
      startedAt: 1_000,
      endedAt: 89_000,
      hasProcess: true,
      isOpen: false,
    })
  })

  it('never folds what the user said, not even mid-turn', () => {
    const rows = [
      row(said('q1')),
      row(thought('t')),
      row(said('q2')),
      row(spoke('a', '两处都改好了。')),
    ]

    expect(idsOf(foldFeed(rows, settled, new Set<number>()).rows)).toEqual(['q1', 'q2', 'a'])
  })

  it('reads past an error to find the answer, and keeps the error', () => {
    const rows = [row(said('q')), row(thought('t')), row(spoke('a', '好了。')), row(broke('e'))]

    expect(idsOf(foldFeed(rows, settled, new Set<number>()).rows)).toEqual(['q', 'a', 'e'])
  })

  it('folds nothing when the turn ended on its process', () => {
    const rows = [row(said('q')), row(thought('t'))]
    const feed = foldFeed(rows, settled, new Set<number>())

    expect(feed.rows).toBe(rows)
    expect(feed.seals.get('t')?.hasProcess).toBe(false)
  })

  it('opens the turn on request and says so', () => {
    const rows = [row(said('q')), row(thought('t')), row(spoke('a', '好了。'))]
    const feed = foldFeed(rows, settled, new Set([0]))

    expect(feed.rows).toBe(rows)
    expect(feed.seals.get('t')?.isOpen).toBe(true)
    expect(feed.seals.get('t')?.hasProcess).toBe(true)
  })

  it('folds each turn on its own', () => {
    const rows = [
      row(said('q0')),
      row(thought('t0')),
      row(spoke('a0', '第一轮好了。')),
      row(said('q1', 1)),
      row(thought('t1', 1)),
      row(spoke('a1', '第二轮好了。', 1)),
    ]

    const feed = foldFeed(
      rows,
      [
        { turn: 0, startedAt: 0, endedAt: 1_000 },
        { turn: 1, startedAt: 2_000, endedAt: 5_000 },
      ],
      new Set([1]),
    )

    expect(idsOf(feed.rows)).toEqual(['q0', 'a0', 'q1', 't1', 'a1'])
    expect(feed.seals.get('a0')?.isOpen).toBe(false)
    expect(feed.seals.get('t1')?.isOpen).toBe(true)
  })
})

describe('folding a turn that has not settled', () => {
  it('shows everything and offers no toggle', () => {
    const rows = [row(said('q')), row(thought('t'))]
    const feed = foldFeed(rows, running, new Set<number>())

    expect(feed.rows).toBe(rows)
    expect(feed.seals.get('t')?.endedAt).toBeUndefined()
    expect(feed.seals.get('t')?.hasProcess).toBe(false)
  })

  it('draws no seal at all for a log that never recorded a start', () => {
    const rows = [row(said('q')), row(spoke('a', '这是上个月那条对话。'))]
    const feed = foldFeed(rows, [], new Set<number>())

    expect(feed.rows).toBe(rows)
    expect(feed.seals.size).toBe(0)
  })
})
