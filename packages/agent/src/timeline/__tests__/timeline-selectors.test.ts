import { describe, expect, it } from 'bun:test'

import { SAMPLE_RUN_EVENTS } from '../__fixtures__/sample-run'
import { selectPresentation } from '../presentation'
import type { QueuedPromptItem, TimelineItem } from '../timeline-contract'
import { queuedPrompts, selectIsBusy, type WaitingScope } from '../timeline-queries'
import { replayRunEvents } from '../timeline-reducer'

const NOTHING_FOLDED: ReadonlyMap<number, boolean> = new Map()

describe('timeline selectors', () => {
  it('marks no streaming tail once the run has finished', () => {
    const state = replayRunEvents(SAMPLE_RUN_EVENTS)
    const feed = selectPresentation(state, NOTHING_FOLDED)

    expect(feed.count).toBeGreaterThan(0)
    expect(selectIsBusy(state)).toBe(false)

    for (let index = 0; index < feed.count; index += 1) {
      expect(feed.rowAt(index)?.isStreamingTail).toBe(false)
    }
  })

  it('marks the growing tail while the run is live', () => {
    const partial = SAMPLE_RUN_EVENTS.filter((event) => event.kind !== 'run_finished')
    const feed = selectPresentation(replayRunEvents(partial), NOTHING_FOLDED)

    expect(feed.rowAt(feed.count - 1)?.isStreamingTail).toBe(true)
  })

  /*
   * 队列条经 useSyncExternalStore 订这一格：渲染期与提交期各调一次 getSnapshot，
   * 两趟不同引用就是无限重渲。同一段必须交回同一个数组，换段才换数组。
   */
  it('hands the same queue snapshot out while the segment stands', () => {
    const queued: QueuedPromptItem = {
      type: 'queued_prompt',
      id: 't1:queued:p1',
      turn: 1,
      at: 1,
      promptId: 'p1',
      text: '再补一句',
    }
    const items: readonly TimelineItem[] = [queued]
    const scope: WaitingScope = { items, status: 'running' }

    expect(queuedPrompts(scope)).toBe(queuedPrompts(scope))
    expect(queuedPrompts(scope)).toEqual([queued])

    const settled: readonly TimelineItem[] = [{ ...queued, settled: true }]

    expect(queuedPrompts({ items: settled, status: 'running' })).toEqual([])
  })
})
