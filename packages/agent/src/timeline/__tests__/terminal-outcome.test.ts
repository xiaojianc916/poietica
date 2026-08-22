import type { RunEvent } from '@poietica/agent-contract'
import { describe, expect, it } from 'vitest'
import { allItems } from '../timeline-contract'
import { replayRunEvents } from '../timeline-reducer'

const started = (seq: number): RunEvent => ({
  kind: 'run_started',
  seq,
  at: seq,
  sessionId: 'sess',
  prompt: 'hello',
  images: [],
})

describe('terminal outcome projection', () => {
  it('does not turn an empty completed response into an error', () => {
    const state = replayRunEvents([
      started(1),
      { kind: 'run_finished', seq: 2, at: 2, stopReason: 'completed' },
    ])

    expect(state.status).toBe('completed')
    expect(allItems(state).some((item) => item.type === 'error')).toBe(false)
  })

  it('surfaces the structured KAP failure and keeps the failed status', () => {
    const state = replayRunEvents([
      started(1),
      {
        kind: 'kap_event',
        seq: 2,
        at: 2,
        payload: {
          type: 'turn.ended',
          agentId: 'main',
          reason: 'failed',
          error: {
            code: 'MODEL_QUOTA',
            message: 'Insufficient balance',
            retryable: false,
          },
        },
      },
      { kind: 'run_finished', seq: 3, at: 3, stopReason: 'failed' },
    ])

    expect(state.status).toBe('failed')
    expect(allItems(state)).toContainEqual(
      expect.objectContaining({ type: 'error', message: 'MODEL_QUOTA: Insufficient balance' }),
    )
  })
})
