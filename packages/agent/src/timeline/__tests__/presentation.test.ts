import { describe, expect, it } from 'vitest'

import { SAMPLE_RUN_EVENTS } from '../__fixtures__/sample-run'
import { selectPresentation } from '../presentation'
import type { TimelineItem, TimelineItemId, TimelineState, TurnSpan } from '../timeline-contract'
import { createTimelineState, replayRunEvents } from '../timeline-reducer'

const SHUT: ReadonlySet<TimelineItemId> = new Set()

function said(id: string, turn: number, at: number, text = '问'): TimelineItem {
  return { at, id, text, turn, type: 'user_message' }
}

function spoke(id: string, turn: number, at: number, text = '答'): TimelineItem {
  return { at, id, sealed: true, text, turn, type: 'agent_text' }
}

function planned(id: string, turn: number, at: number): TimelineItem {
  return { at, entries: [{ content: '一步', status: 'completed' }], id, turn, type: 'plan' }
}

function broke(id: string, turn: number, at: number): TimelineItem {
  return { at, id, message: '炸了', turn, type: 'error' }
}

function stateOf(
  pages: readonly (readonly TimelineItem[])[],
  spans: readonly TurnSpan[],
): TimelineState {
  const built = pages.map((items, index) => ({ items, turn: index + 1 }))

  return {
    ...createTimelineState(),
    active: built.at(-1) ?? { items: [], turn: 1 },
    sealed: built.slice(0, -1),
    spans,
  }
}

function idsOf(feed: ReturnType<typeof selectPresentation>): readonly string[] {
  const out: string[] = []

  for (let i = 0; i < feed.count; i += 1) {
    const id = feed.rowAt(i)?.item.id

    if (id !== undefined) {
      out.push(id)
    }
  }

  return out
}

describe('presentation projection', () => {
  const settled = stateOf(
    [[said('s1', 1, 1), planned('p1', 1, 2), spoke('a1', 1, 3)]],
    [{ endedAt: 4, firstFrameAt: 2, startedAt: 1, turn: 1 }],
  )

  it('folds the process of a settled turn and keeps the answer', () => {
    const feed = selectPresentation(settled, SHUT)

    expect(idsOf(feed)).toEqual(['s1', 'a1'])
  })

  it('opens the same turn back to full length', () => {
    const feed = selectPresentation(settled, new Set<TimelineItemId>(['s1']))

    expect(idsOf(feed)).toEqual(['s1', 'p1', 'a1'])
    expect(feed.processOf(0)).toBeUndefined()
    expect(feed.processOf(1)).toBe('s1')
    expect(feed.sealAt(0)?.isOpen).toBe(true)
  })

  it('reads the seal clock off the span and hangs it after the question', () => {
    const feed = selectPresentation(settled, SHUT)

    expect(feed.sealAt(0)).toEqual({
      endedAt: 4,
      hasProcess: true,
      id: 's1',
      isOpen: false,
      startedAt: 2,
    })
    expect(feed.sealAt(1)).toBeUndefined()
  })

  it('hangs the seal on a running turn before it speaks', () => {
    const feed = selectPresentation(
      stateOf(
        [[said('s1', 1, 1), planned('p1', 1, 2)]],
        [{ firstFrameAt: 2, startedAt: 1, turn: 1 }],
      ),
      SHUT,
    )

    expect(idsOf(feed)).toEqual(['s1', 'p1'])
    expect(feed.sealAt(0)).toEqual({
      endedAt: undefined,
      hasProcess: false,
      id: 's1',
      isOpen: false,
      startedAt: 2,
    })
    expect(feed.sealAt(1)).toBeUndefined()
  })

  it('has no seal and folds nothing without a first frame', () => {
    const feed = selectPresentation(
      stateOf(
        [[said('s1', 1, 1), planned('p1', 1, 2), spoke('a1', 1, 3)]],
        [{ endedAt: 4, startedAt: 1, turn: 1 }],
      ),
      SHUT,
    )

    expect(idsOf(feed)).toEqual(['s1', 'p1', 'a1'])
    expect(feed.sealAt(1)).toBeUndefined()
  })

  it('never folds an aside', () => {
    const feed = selectPresentation(
      stateOf(
        [[said('s1', 1, 1), broke('e1', 1, 2), planned('p1', 1, 3), spoke('a1', 1, 4)]],
        [{ endedAt: 5, firstFrameAt: 2, startedAt: 1, turn: 1 }],
      ),
      SHUT,
    )

    expect(idsOf(feed)).toEqual(['s1', 'e1', 'a1'])
  })

  it('keeps the newest item of a speechless running turn in place', () => {
    const feed = selectPresentation(
      stateOf(
        [[said('s1', 1, 1), spoke('a1', 1, 2), planned('p1', 1, 3)]],
        [{ firstFrameAt: 2, startedAt: 1, turn: 1 }],
      ),
      SHUT,
    )

    expect(idsOf(feed)).toEqual(['s1', 'p1'])
    expect(feed.processOf(1)).toBeUndefined()
    expect(feed.replyAt(1)).toBeUndefined()
  })

  it('anchors the reply action on the last visible row of a settled turn', () => {
    const feed = selectPresentation(settled, SHUT)

    expect(feed.replyAt(0)).toBeUndefined()
    expect(feed.replyAt(1)?.text).toBe('答')
  })

  it('carries an unanswered question into the next rail entry', () => {
    const feed = selectPresentation(
      stateOf(
        [[said('s1', 1, 1)], [said('s2', 2, 2), spoke('a2', 2, 3)]],
        [
          { startedAt: 1, turn: 1 },
          { endedAt: 4, startedAt: 2, turn: 2 },
        ],
      ),
      SHUT,
    )

    expect(feed.turns).toHaveLength(1)
    expect(feed.turns[0]?.id).toBe('s2')
    expect(feed.turns[0]?.rowIndex).toBe(0)
  })

  it('addresses rows by index both ways', () => {
    const feed = selectPresentation(settled, SHUT)

    expect(feed.count).toBe(2)
    expect(feed.indexOf('a1')).toBe(1)
    expect(feed.indexOf('p1')).toBe(-1)
    expect(feed.latestOwnMessage).toBe('s1')
    expect(feed.lastTurn).toBe(1)
  })

  it('hands back the same rows and the same rail when nothing changed', () => {
    const first = selectPresentation(settled, SHUT)

    expect(selectPresentation(settled, SHUT)).toBe(first)

    /* opened 按引用比较：换一个实例就重算，但行与轮次走弱表缓存，引用不换。 */
    const again = selectPresentation(settled, new Set())

    expect(again).not.toBe(first)
    expect(again.turns).toBe(first.turns)
    expect(again.rowAt(0)).toBe(first.rowAt(0))
  })

  it('reads one turn out of the sample conversation', () => {
    const feed = selectPresentation(replayRunEvents(SAMPLE_RUN_EVENTS), SHUT)

    expect(feed.turns).toHaveLength(1)
    expect(feed.turns[0]?.rowIndex).toBe(0)
    expect(feed.turns[0]?.label).toBe('把 README 里的构建命令核对一遍')
    expect(feed.turns[0]?.reply).toBe('构建命令与 scripts 一致。')
  })
})
