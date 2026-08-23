import { describe, expect, it } from 'vitest'

import { SAMPLE_RUN_EVENTS } from '../__fixtures__/sample-run'
import { selectPresentation } from '../presentation'
import { selectIsBusy } from '../timeline-queries'
import { replayRunEvents } from '../timeline-reducer'

const SHUT: ReadonlySet<string> = new Set()

describe('timeline selectors', () => {
  it('marks no streaming tail once the run has finished', () => {
    const state = replayRunEvents(SAMPLE_RUN_EVENTS)
    const feed = selectPresentation(state, SHUT)

    expect(feed.count).toBeGreaterThan(0)
    expect(selectIsBusy(state)).toBe(false)

    for (let index = 0; index < feed.count; index += 1) {
      expect(feed.rowAt(index)?.isStreamingTail).toBe(false)
    }
  })

  it('marks the growing tail while the run is live', () => {
    const partial = SAMPLE_RUN_EVENTS.filter((event) => event.kind !== 'run_finished')
    const feed = selectPresentation(replayRunEvents(partial), SHUT)

    expect(feed.rowAt(feed.count - 1)?.isStreamingTail).toBe(true)
  })
})
