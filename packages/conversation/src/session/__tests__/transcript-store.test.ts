import { describe, expect, test } from 'bun:test'
import {
  type AgentTranscriptSnapshot,
  itemId,
  TranscriptStore as ProtocolStore,
} from '@poietica/transcript'
import type {
  AgentSessionPort,
  TranscriptPage,
  TranscriptPort,
  TranscriptSignal,
} from '../../agent'
import { delegateKey } from '../../timeline'
import { TranscriptReplica } from '../transcript-replica'
import { TranscriptStore } from '../transcript-store'

function page(agentId = 'main', seq = 0, patch: Partial<TranscriptPage> = {}): TranscriptPage {
  return {
    ...new ProtocolStore('session').ensureAgent(agentId).snapshot(),
    agentId,
    seq,
    agents: [
      { agentId: 'main', type: 'main' },
      { agentId: 'worker', type: 'sub', parentAgentId: 'main' },
    ],
    pendingInteractions: [],
    ...patch,
  }
}

function deferred<T>() {
  let release: (value: T) => void = () => {
    throw new Error('Promise executor did not run.')
  }
  const promise = new Promise<T>((resolve) => {
    release = resolve
  })
  return { promise, resolve: (value: T) => release(value) }
}

function transcriptPort(patch: Partial<TranscriptPort> = {}): TranscriptPort {
  return {
    subscribeTranscript: () => () => undefined,
    readTranscript: async (_session, agent) => page(agent),
    catchUpTranscript: async (_session, agent, seq) => ({
      agentId: agent,
      batches: [],
      latestSeq: seq,
      complete: true,
    }),
    ...patch,
  }
}

function sessionPort(
  transcript: TranscriptPort,
  patch: Partial<AgentSessionPort> = {},
): AgentSessionPort {
  return {
    transcript,
    prompt: async () => ({ sessionId: 'session' }),
    cancel: async () => undefined,
    steer: async () => undefined,
    abortPrompt: async () => undefined,
    resolvePermission: async () => undefined,
    answerQuestions: async () => undefined,
    dismissQuestions: async () => undefined,
    ...patch,
  }
}

function ops(agentId: string, seq: number): TranscriptSignal {
  return { kind: 'ops', sessionId: 'session', agentId, seq, ops: [] }
}

describe('TranscriptReplica ownership and recovery', () => {
  test('ignores duplicate batches without reading the network', async () => {
    let reads = 0
    const replica = new TranscriptReplica(
      'session',
      transcriptPort({
        catchUpTranscript: async (_session, agent, seq) => {
          reads += 1
          return { agentId: agent, batches: [], latestSeq: seq, complete: true }
        },
      }),
      () => undefined,
    )
    replica.seed(page('main', 4))
    await replica.receive(ops('main', 4))
    await replica.receive(ops('main', 3))
    expect(reads).toBe(0)
    replica.dispose()
  })

  test('does not publish a snapshot after its owner is disposed', async () => {
    const entered = deferred<void>()
    const answer = deferred<TranscriptPage>()
    const published: AgentTranscriptSnapshot[] = []
    const replica = new TranscriptReplica(
      'session',
      transcriptPort({
        readTranscript: async () => {
          entered.resolve()
          return answer.promise
        },
      }),
      (_agent, snapshot) => published.push(snapshot),
    )
    const work = replica.refresh('main')
    await entered.promise
    replica.dispose()
    answer.resolve(page('main', 1))
    await work
    expect(published).toHaveLength(0)
  })

  test('serializes one agent while allowing another agent to proceed', async () => {
    let mainReads = 0
    const entered = deferred<void>()
    const release = deferred<void>()
    const replica = new TranscriptReplica(
      'session',
      transcriptPort({
        readTranscript: async (_session, agent) => {
          if (agent === 'main') {
            mainReads += 1
            if (mainReads === 1) {
              entered.resolve()
              await release.promise
            }
          }
          return page(agent, agent === 'main' ? mainReads : 1)
        },
      }),
      () => undefined,
    )
    const first = replica.refresh('main')
    const second = replica.refresh('main')
    await entered.promise
    await replica.refresh('worker')
    expect(mainReads).toBe(1)
    release.resolve()
    await Promise.all([first, second])
    expect(mainReads).toBe(2)
    replica.dispose()
  })

  test('rejects an incomplete catch-up prefix and restores from a snapshot', async () => {
    let heads = 0
    const replica = new TranscriptReplica(
      'session',
      transcriptPort({
        catchUpTranscript: async (_session, agent) => ({
          agentId: agent,
          batches: [{ seq: 6, ops: [] }],
          latestSeq: 8,
          complete: true,
        }),
        readTranscript: async (_session, agent) => {
          heads += 1
          return page(agent, 8)
        },
      }),
      () => undefined,
    )
    replica.seed(page('main', 5))
    await replica.synchronize('main')
    await replica.receive(ops('main', 8))
    expect(heads).toBe(1)
    replica.dispose()
  })

  test('merges historical entities without replacing the live cursor', async () => {
    const published: AgentTranscriptSnapshot[] = []
    let catches = 0
    const replica = new TranscriptReplica(
      'session',
      transcriptPort({
        readTranscript: async (_session, agent) =>
          page(agent, 0, {
            items: [{ kind: 'marker', markerId: 'earlier', marker: 'notice' }],
            attachments: [
              { attachmentId: 'shared', mediaType: 'text/plain', name: 'earlier' },
              { attachmentId: 'historical', mediaType: 'text/plain' },
            ],
          }),
        catchUpTranscript: async (_session, agent, seq) => {
          catches += 1
          return { agentId: agent, batches: [], latestSeq: seq, complete: true }
        },
      }),
      (_agent, snapshot) => published.push(snapshot),
    )
    replica.seed(
      page('main', 10, {
        items: [{ kind: 'marker', markerId: 'current', marker: 'notice' }],
        attachments: [{ attachmentId: 'shared', mediaType: 'text/plain', name: 'current' }],
      }),
    )
    await replica.readEarlier('main', 'boundary')
    await replica.receive(ops('main', 11))
    const latest = published.at(-1)
    expect(catches).toBe(0)
    expect(latest?.items.map(itemId)).toEqual(['earlier', 'current'])
    expect(latest?.attachments.find((value) => value.attachmentId === 'shared')?.name).toBe(
      'current',
    )
    expect(latest?.attachments.some((value) => value.attachmentId === 'historical')).toBe(true)
    replica.dispose()
  })
})

describe('TranscriptStore lifecycle', () => {
  test('keeps main and subagent reducers isolated without timing guesses', async () => {
    let receive: (signal: TranscriptSignal) => void = () => {
      throw new Error('Not subscribed.')
    }
    const store = new TranscriptStore()
    store.ensure(
      sessionPort(
        transcriptPort({
          subscribeTranscript: (listener) => {
            receive = listener
            return () => undefined
          },
        }),
      ),
    )
    store.route('session', 'thread', page())
    const key = delegateKey('thread', 'worker')
    const loaded = new Promise<void>((resolve) => {
      const off = store.subscribe(key, () => {
        if (store.read(key).loaded) {
          off()
          resolve()
        }
      })
    })
    receive(ops('worker', 1))
    await loaded
    expect(store.read('thread').loaded).toBe(true)
    expect(store.read(key).loaded).toBe(true)
    store.dispose()
  })

  test('a late prompt response cannot resurrect a forgotten conversation', async () => {
    const entered = deferred<void>()
    const answer = deferred<{ sessionId: string }>()
    const port = sessionPort(transcriptPort(), {
      prompt: async () => {
        entered.resolve()
        return answer.promise
      },
    })
    const store = new TranscriptStore()
    const sent = store.send({
      port,
      threadId: 'thread',
      text: 'hello',
      assets: [],
      configuration: [],
      skills: [],
    })
    await entered.promise
    store.forget('thread')
    answer.resolve({ sessionId: 'session' })
    expect(await sent).toBe(false)
    expect(store.ownerOf('session')).toBeUndefined()
    expect(store.read('thread').owned).toBe(false)
    store.dispose()
  })

  test('forget terminates its terminal waiters', async () => {
    const store = new TranscriptStore()
    const waiting = store.waitForTerminal('thread')
    store.forget('thread')
    await expect(waiting).rejects.toMatchObject({ name: 'AbortError' })
    store.dispose()
  })

  test('an unavailable submission fails and clears the running projection', async () => {
    const store = new TranscriptStore()
    expect(
      await store.send({
        port: undefined,
        threadId: 'thread',
        text: 'hello',
        assets: [],
        configuration: [],
        skills: [],
      }),
    ).toBe(false)
    expect(store.read('thread').timeline.status).toBe('failed')
    expect(store.runningSnapshot().has('thread')).toBe(false)
    expect(await store.waitForTerminal('thread')).toBe('failed')
    store.dispose()
  })

  test('subscription ownership is idempotent and cannot restart after disposal', () => {
    let stopped = 0
    const port = sessionPort(
      transcriptPort({
        subscribeTranscript: () => () => {
          stopped += 1
        },
      }),
    )
    const store = new TranscriptStore()
    store.ensure(port)
    store.ensure(port)
    store.dispose()
    store.dispose()
    expect(stopped).toBe(1)
    expect(() => store.ensure(port)).toThrow('disposed')
  })
})
