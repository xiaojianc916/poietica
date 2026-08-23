import { describe, expect, it } from 'vitest'

import { SAMPLE_RUN_EVENTS } from '../__fixtures__/sample-run'
import { selectPresentation } from '../presentation'
import type { TimelineItem, TimelineState, TurnSpan } from '../timeline-contract'
import { createTimelineState, replayRunEvents } from '../timeline-reducer'

/** 没人亲手定过开合：跑着摊开，停了收起，全由投影按运行事实算。 */
const AUTO: ReadonlyMap<number, boolean> = new Map()
/** 人亲手摊开了第一轮。 */
const OPENED: ReadonlyMap<number, boolean> = new Map([[1, true]])
/** 人亲手收起了第一轮。 */
const SHUT: ReadonlyMap<number, boolean> = new Map([[1, false]])

function said(id: string, turn: number, at: number, text = '问'): TimelineItem {
  return { at, id, text, turn, type: 'user_message' }
}

function spoke(id: string, turn: number, at: number, text = '答'): TimelineItem {
  return { at, id, sealed: true, text, turn, type: 'agent_text' }
}

function planned(id: string, turn: number, at: number): TimelineItem {
  return { at, entries: [{ content: '一步', status: 'completed' }], id, turn, type: 'plan' }
}

function thought(id: string, turn: number, at: number): TimelineItem {
  return { at, id, sealed: true, text: '想', turn, type: 'agent_thought' }
}

function broke(id: string, turn: number, at: number): TimelineItem {
  return { at, id, message: '炸了', turn, type: 'error' }
}

function stateOf(
  pages: readonly (readonly TimelineItem[])[],
  spans: readonly TurnSpan[],
  status?: TimelineState['status'],
): TimelineState {
  const built = pages.map((items, index) => ({ items, turn: index + 1 }))

  return {
    ...createTimelineState(),
    active: built.at(-1) ?? { items: [], turn: 1 },
    sealed: built.slice(0, -1),
    ...(status === undefined ? null : { status }),
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
    [{ endedAt: 4, lastFrameAt: 3, startedAt: 1, turn: 1 }],
  )

  it('folds the process the moment the turn settles, and reopens on demand', () => {
    expect(idsOf(selectPresentation(settled, AUTO))).toEqual(['s1', 'a1'])
    expect(idsOf(selectPresentation(settled, OPENED))).toEqual(['s1', 'p1', 'a1'])
  })

  it('reads the seal clock off the span and hangs it after the question', () => {
    const feed = selectPresentation(settled, AUTO)

    expect(feed.sealAt(0)).toEqual({
      endedAt: 4,
      hasProcess: true,
      isLive: false,
      isOpen: false,
      lastFrameAt: 3,
      startedAt: 1,
      turn: 1,
    })
    expect(feed.sealAt(1)).toBeUndefined()
  })

  it('leaves a running turn open, and collapses it only when told to', () => {
    const state = stateOf(
      [[said('s1', 1, 1), planned('p1', 1, 2)]],
      [{ lastFrameAt: 2, startedAt: 1, turn: 1 }],
      'running',
    )
    const feed = selectPresentation(state, AUTO)

    expect(idsOf(feed)).toEqual(['s1', 'p1'])
    expect(feed.sealAt(0)).toEqual({
      endedAt: undefined,
      hasProcess: true,
      isLive: true,
      isOpen: true,
      lastFrameAt: 2,
      startedAt: 1,
      turn: 1,
    })
    expect(idsOf(selectPresentation(state, SHUT))).toEqual(['s1'])
  })

  it('seals a turn it has no clock for, without inventing one', () => {
    const feed = selectPresentation(
      stateOf([[said('s1', 1, 1), planned('p1', 1, 2), spoke('a1', 1, 3)]], []),
      AUTO,
    )

    expect(idsOf(feed)).toEqual(['s1', 'a1'])
    expect(feed.sealAt(0)).toEqual({
      endedAt: undefined,
      hasProcess: true,
      isLive: false,
      isOpen: false,
      lastFrameAt: undefined,
      startedAt: undefined,
      turn: 1,
    })
  })

  it('never folds an aside', () => {
    const feed = selectPresentation(
      stateOf(
        [[said('s1', 1, 1), broke('e1', 1, 2), planned('p1', 1, 3), spoke('a1', 1, 4)]],
        [{ endedAt: 5, lastFrameAt: 4, startedAt: 1, turn: 1 }],
      ),
      AUTO,
    )

    expect(idsOf(feed)).toEqual(['s1', 'e1', 'a1'])
  })

  it('keeps a turn that has not spoken yet foldable while it runs', () => {
    const state = stateOf(
      [[said('s1', 1, 1), thought('t1', 1, 2), planned('p1', 1, 3)]],
      [{ lastFrameAt: 3, startedAt: 1, turn: 1 }],
      'running',
    )

    expect(idsOf(selectPresentation(state, AUTO))).toEqual(['s1', 't1', 'p1'])
    expect(selectPresentation(state, AUTO).sealAt(0)?.hasProcess).toBe(true)
    expect(idsOf(selectPresentation(state, SHUT))).toEqual(['s1'])
  })

  it('hides nothing when a run stops before it says anything', () => {
    const state = stateOf(
      [[said('s1', 1, 1), thought('t1', 1, 2), planned('p1', 1, 3)]],
      [{ endedAt: 4, lastFrameAt: 3, startedAt: 1, turn: 1 }],
      'failed',
    )
    const feed = selectPresentation(state, AUTO)

    expect(idsOf(feed)).toEqual(['s1', 't1', 'p1'])
    expect(feed.sealAt(0)?.hasProcess).toBe(false)
  })

  it('treats the text a stopped run managed to print as the reply', () => {
    const state = stateOf(
      [[said('s1', 1, 1), thought('t1', 1, 2), planned('p1', 1, 3), spoke('a1', 1, 4, '半句')]],
      [{ endedAt: 5, lastFrameAt: 4, startedAt: 1, turn: 1 }],
      'failed',
    )

    expect(idsOf(selectPresentation(state, AUTO))).toEqual(['s1', 'a1'])
  })

  it('folds everything before the newest printed text, not one row at a time', () => {
    const feed = selectPresentation(
      stateOf(
        [
          [
            said('s1', 1, 1),
            thought('t1', 1, 2),
            planned('p1', 1, 3),
            spoke('a1', 1, 4, '碎碎念'),
            planned('p2', 1, 5),
            thought('t2', 1, 6),
            spoke('a2', 1, 7, '最终答复'),
          ],
        ],
        [{ endedAt: 8, lastFrameAt: 7, startedAt: 1, turn: 1 }],
      ),
      AUTO,
    )

    expect(idsOf(feed)).toEqual(['s1', 'a2'])
  })

  it('keeps the reply out of the seal when the run ends on one more call', () => {
    const feed = selectPresentation(
      stateOf(
        [
          [
            said('s1', 1, 1),
            thought('t1', 1, 2),
            spoke('a1', 1, 3, '最终答复'),
            planned('p1', 1, 4),
          ],
        ],
        [{ endedAt: 5, lastFrameAt: 4, startedAt: 1, turn: 1 }],
      ),
      AUTO,
    )

    expect(idsOf(feed)).toEqual(['s1', 'a1', 'p1'])
  })

  it('anchors the reply action on the last row of a settled turn', () => {
    const feed = selectPresentation(settled, AUTO)

    expect(feed.replyAt(0)).toBeUndefined()
    expect(feed.replyAt(feed.indexOf('a1'))?.text).toBe('答')
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
      AUTO,
    )

    expect(feed.turns).toHaveLength(1)
    expect(feed.turns[0]?.id).toBe('s2')
    expect(feed.turns[0]?.rowIndex).toBe(0)
  })

  it('addresses rows by index both ways', () => {
    const feed = selectPresentation(settled, AUTO)

    expect(feed.count).toBe(2)
    expect(feed.indexOf('a1')).toBe(1)
    expect(feed.indexOf('p1')).toBe(-1)
    expect(feed.latestOwnMessage).toBe('s1')
    expect(feed.lastTurn).toBe(1)
  })

  it('hands back the same rows and the same rail when nothing changed', () => {
    const first = selectPresentation(settled, AUTO)

    expect(selectPresentation(settled, AUTO)).toBe(first)

    /* 开合表按引用比较：换一个实例就重算，但行与轮次走弱表缓存，引用不换。 */
    const again = selectPresentation(settled, new Map())

    expect(again).not.toBe(first)
    expect(again.turns).toBe(first.turns)
    expect(again.rowAt(0)).toBe(first.rowAt(0))
  })

  it('folds every stretch of process, including the one behind a queued follow-up', () => {
    const state = stateOf(
      [
        [
          said('s1', 1, 1, '第一问'),
          planned('p1', 1, 2),
          said('s2', 1, 3, '追问'),
          planned('p2', 1, 4),
          spoke('a1', 1, 5, '最终答复'),
        ],
      ],
      [{ endedAt: 6, lastFrameAt: 5, startedAt: 1, turn: 1 }],
    )
    const shut = selectPresentation(state, AUTO)
    const open = selectPresentation(state, OPENED)

    expect(idsOf(shut)).toEqual(['s1', 's2', 'a1'])
    expect(idsOf(open)).toEqual(['s1', 'p1', 's2', 'p2', 'a1'])
    expect(shut.sealAt(shut.indexOf('s1'))?.turn).toBe(1)
    expect(open.sealAt(open.indexOf('s1'))?.turn).toBe(1)
    expect(shut.sealAt(shut.indexOf('s2'))).toBeUndefined()
    expect(open.sealAt(open.indexOf('p1'))).toBeUndefined()
  })

  it('reads one turn out of the sample conversation', () => {
    const feed = selectPresentation(replayRunEvents(SAMPLE_RUN_EVENTS), AUTO)

    expect(feed.turns).toHaveLength(1)
    expect(feed.turns[0]?.rowIndex).toBe(0)
    expect(feed.turns[0]?.label).toBe('把 README 里的构建命令核对一遍')
    expect(feed.turns[0]?.reply).toBe('构建命令与 scripts 一致。')
  })
})
