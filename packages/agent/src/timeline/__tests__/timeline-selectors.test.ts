import { describe, expect, it } from 'bun:test'

import { SAMPLE_RUN_EVENTS } from '../__fixtures__/sample-run'
import { selectPresentation } from '../presentation'
import type { InflightPromptItem } from '../timeline-contract'
import { inflightPromptId, selectIsBusy, type WaitingScope } from '../timeline-queries'
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
   * 出账簿一次只放一条出去，所以在飞的号至多一个。倒扫交出还没落定的那一个；
   * 落定过的不再算 —— 它已经并进这一轮了。单值引用天生稳定，不再需要快照缓存。
   */
  it('hands out the one unsettled inflight prompt', () => {
    const settled: InflightPromptItem = {
      type: 'inflight_prompt',
      id: 't1:inflight-p1',
      turn: 1,
      at: 1,
      promptId: 'p1',
      settled: true,
    }
    const live: InflightPromptItem = {
      type: 'inflight_prompt',
      id: 't1:inflight-p2',
      turn: 1,
      at: 2,
      promptId: 'p2',
    }
    const scope: WaitingScope = { items: [settled, live], status: 'running' }

    expect(inflightPromptId(scope)).toBe('p2')
    expect(inflightPromptId({ items: [settled], status: 'running' })).toBeUndefined()
  })
})
