import { describe, expect, it } from 'bun:test'
import type { RunEvent } from '@poietica/agent-contract'
import { SAMPLE_RUN_EVENTS } from '../__fixtures__/sample-run'
import { replayRunEvents } from '../index'
import { createReplaySession } from './replay-session'

describe('replay session', () => {
  it('emits the recorded run in order under an injected scheduler', async () => {
    const queue: Array<() => void> = []
    const session = createReplaySession({
      events: SAMPLE_RUN_EVENTS,
      scheduler: (callback) => {
        queue.push(callback)
        return () => {}
      },
    })

    const batches: Array<readonly RunEvent[]> = []
    const addressed = new Set<string>()

    session.subscribe((events, sessionId) => {
      batches.push(events)
      addressed.add(sessionId)
    })

    await session.prompt({ threadId: 't', text: 'hi', assets: [], configuration: [], skills: [] })

    for (const step of queue) {
      step()
    }

    const received = batches.flat()

    expect(received).toEqual(SAMPLE_RUN_EVENTS)
    expect(batches).toHaveLength(SAMPLE_RUN_EVENTS.length)
    expect([...addressed]).toEqual(['sess_replay'])
    expect(replayRunEvents(received).status).toBe('completed')
  })
})
