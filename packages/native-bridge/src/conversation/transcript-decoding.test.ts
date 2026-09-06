import { expect, test } from 'bun:test'
import { TranscriptStore as ProtocolStore } from '@poietica/transcript'
import { decodeTranscriptEvent } from './transcript-decoding'

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

test('an empty-tail reset invalidates only its named agent', () => {
  const snapshot = new ProtocolStore('session').ensureAgent('worker').snapshot()
  for (const seq of [undefined, 0, 7]) {
    expect(
      decodeTranscriptEvent({
        sessionId: 'session',
        json: JSON.stringify({
          type: 'transcript.reset',
          payload: {
            agent_id: 'worker',
            snapshot: { ...snapshot, hasMoreOlder: true },
            has_more_older: true,
            seq,
          },
        }),
      }),
    ).toEqual({ ok: true, signal: { kind: 'reset', sessionId: 'session', agentId: 'worker' } })
  }
})

test('a malformed reset is rejected without exposing its private input', () => {
  const decoded = decodeTranscriptEvent({
    sessionId: 'session',
    json: JSON.stringify({
      type: 'transcript.reset',
      payload: { agent_id: 'worker', snapshot: { prompt: 'private prompt' }, has_more_older: true },
    }),
  })
  expect(decoded.ok).toBe(false)
  if (!decoded.ok) {
    expect(decoded.error.message).not.toContain('private prompt')
  }
})
