import { describe, expect, test } from 'bun:test'
import type { AgentTranscriptSnapshot } from '@poietica/transcript'
import type { AgentSessionPort, TranscriptSignal } from '../../agent'
import { delegateKey } from '../../timeline'
import { TranscriptStore } from '../transcript-store'

const emptySnapshot = {
  items: [],
  tasks: [],
  interactions: [],
  attachments: [],
  todos: [],
  prompts: [],
  meta: {},
  hasMoreOlder: false,
} as unknown as AgentTranscriptSnapshot

function page(agentId: string) {
  return {
    ...emptySnapshot,
    agentId,
    agents: [
      { agentId: 'main', type: 'main' as const },
      { agentId: 'worker-1', type: 'sub' as const, parentAgentId: 'main' },
    ],
    pendingInteractions: [],
    seq: 0,
  }
}

describe('TranscriptStore', () => {
  test('keeps main and subagent reducers isolated', async () => {
    let receive: ((signal: TranscriptSignal) => void) | undefined
    const port = {
      transcript: {
        subscribeTranscript: (listener) => {
          receive = listener
          return () => undefined
        },
        readTranscript: async (_sessionId, agentId) => page(agentId),
        catchUpTranscript: async (_sessionId, agentId, sinceSeq) => ({
          agentId,
          batches: [],
          latestSeq: sinceSeq,
          complete: true,
        }),
      },
      prompt: async () => ({ sessionId: 'session-1' }),
      cancel: async () => undefined,
      steer: async () => undefined,
      abortPrompt: async () => undefined,
      resolvePermission: async () => undefined,
      answerQuestions: async () => undefined,
      dismissQuestions: async () => undefined,
    } satisfies AgentSessionPort
    const store = new TranscriptStore()
    store.ensure(port)
    store.route('session-1', 'thread-1')
    await Promise.resolve()
    await Promise.resolve()
    expect(store.read('thread-1').loaded).toBe(true)
    if (receive === undefined) {
      throw new Error('transcript listener was not installed')
    }
    receive({
      kind: 'reset',
      sessionId: 'session-1',
      agentId: 'worker-1',
      seq: 0,
      snapshot: emptySnapshot,
    })
    await Promise.resolve()
    expect(store.read('thread-1').loaded).toBe(true)
    expect(store.read(delegateKey('thread-1', 'worker-1')).loaded).toBe(true)
  })
})
