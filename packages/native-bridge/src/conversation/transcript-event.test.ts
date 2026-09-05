import { expect, test } from 'bun:test'
import { decodeTranscriptEvent } from './transcript-event'

test('malformed data is isolated and does not prevent the next valid event', () => {
  expect(decodeTranscriptEvent({ sessionId: 'session', json: '{' }).ok).toBe(false)
  expect(decodeTranscriptEvent({ sessionId: 'session', json: 'null' }).ok).toBe(false)
  expect(
    decodeTranscriptEvent({
      sessionId: 'session',
      json: JSON.stringify({
        type: 'unrelated',
        payload: {},
      }),
    }).ok,
  ).toBe(false)
  expect(
    decodeTranscriptEvent({
      sessionId: 'session',
      json: JSON.stringify({
        type: 'transcript.ops',
        payload: { agent_id: 'main', seq: 1, ops: [] },
      }),
    }),
  ).toEqual({
    ok: true,
    signal: {
      kind: 'ops',
      sessionId: 'session',
      agentId: 'main',
      seq: 1,
      ops: [],
    },
  })
})

test('a recovery message remains a recovery message', () => {
  expect(
    decodeTranscriptEvent({
      sessionId: 'session',
      json: JSON.stringify({
        type: 'resync_required',
        payload: { reason: 'buffer_overflow' },
      }),
    }),
  ).toEqual({
    ok: true,
    signal: {
      kind: 'resync',
      sessionId: 'session',
      reason: 'buffer_overflow',
    },
  })
})
