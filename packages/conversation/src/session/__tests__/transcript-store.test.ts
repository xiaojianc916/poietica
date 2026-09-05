import { describe, expect, test } from 'bun:test'
import {
  type AgentTranscriptSnapshot,
  itemId,
  TranscriptStore as ProtocolStore,
  type TranscriptTurn,
} from '@poietica/transcript'
import type {
  AgentPromptHandle,
  AgentSessionPort,
  TranscriptPage,
  TranscriptPort,
  TranscriptSignal,
} from '../../agent'
import { delegateKey, projectTranscript } from '../../timeline'
import { promptOutcome } from '../../timeline/transcript-projector'
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
    prompt: async () => ({ sessionId: 'session', promptId: 'prompt' }),
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
        catchUpTranscript: (_session, agent, seq) => {
          reads += 1
          return Promise.resolve({ agentId: agent, batches: [], latestSeq: seq, complete: true })
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
        readTranscript: () => {
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
        readTranscript: (_session, agent) => {
          heads += 1
          return Promise.resolve(page(agent, 8))
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
        catchUpTranscript: (_session, agent, seq) => {
          catches += 1
          return Promise.resolve({ agentId: agent, batches: [], latestSeq: seq, complete: true })
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
    const answer = deferred<AgentPromptHandle>()
    const port = sessionPort(transcriptPort(), {
      prompt: () => {
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
    answer.resolve({ sessionId: 'session', promptId: 'prompt' })
    expect(await sent).toBeNull()
    expect(store.ownerOf('session')).toBeUndefined()
    expect(store.read('thread').owned).toBe(false)
    store.dispose()
  })

  test('forget terminates its terminal waiters', async () => {
    const store = new TranscriptStore()
    const waiting = store.waitForTerminal('thread', 'acknowledged-prompt')
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
    ).toBeNull()
    expect(store.read('thread').status).toBe('failed')
    expect(store.read('thread').timeline.status).toBe('idle')
    expect(store.read('thread').submissions[0]?.text).toBe('hello')
    expect(store.runningSnapshot().has('thread')).toBe(false)
    expect(store.read('thread').timeline.active.items).toEqual([])
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

function officialTurn(
  turnId: string,
  promptId: string,
  ordinal: number,
  state: TranscriptTurn['state'] = 'completed',
): TranscriptTurn {
  return {
    kind: 'turn',
    turnId,
    triggerPromptId: promptId,
    ordinal,
    state,
    origin: { kind: 'user' },
    prompt: 'message',
    steps: [],
    startedAt: '2026-01-01T00:00:00Z',
  }
}

describe('authoritative transcript projections', () => {
  test('prepending history does not renumber an existing turn', () => {
    const active = officialTurn('active-turn', 'active-prompt', 42)
    const first = projectTranscript(page('main', 0, { items: [active] }))
    const expanded = projectTranscript(
      page('main', 0, {
        items: [officialTurn('earlier-turn', 'earlier-prompt', 3), active],
      }),
    )
    expect(first.active.turn).toBe(42)
    expect(expanded.active.turn).toBe(42)
    expect(expanded.active.items[0]?.turn).toBe(first.active.items[0]?.turn)
    expect(expanded.sealed[0]?.turn).toBe(3)
  })

  test('an interaction without a protocol timestamp has no invented arrival time', () => {
    const snapshot = page('main', 0, {
      interactions: [{ interactionId: 'approval', interactionKind: 'approval', state: 'pending' }],
    })
    const first = projectTranscript(snapshot)
    expect(first.active.items[0]?.at).toBe(0)
    expect(projectTranscript(snapshot)).toEqual(first)
  })

  test('a queued prompt remains active after the preceding turn has ended', () => {
    const snapshot = page('main', 0, {
      items: [officialTurn('preceding-turn', 'preceding-prompt', 8)],
      prompts: [{ promptId: 'queued-prompt', status: 'queued', createdAt: '2026-01-01T00:00:01Z' }],
    })
    expect(projectTranscript(snapshot).status).toBe('submitted')
    expect(promptOutcome(snapshot, 'queued-prompt')).toBeNull()
    expect(promptOutcome(snapshot, 'preceding-prompt')).toBe('completed')
    expect(promptOutcome(snapshot, 'unrelated-prompt')).toBeNull()
  })

  test('submission intent is not inserted into the official content', async () => {
    const entered = deferred<void>()
    const answer = deferred<AgentPromptHandle>()
    const store = new TranscriptStore({ now: () => 123 })
    const sending = store.send({
      port: sessionPort(transcriptPort(), {
        prompt: () => {
          entered.resolve()
          return answer.promise
        },
      }),
      threadId: 'thread',
      text: 'pending text',
      assets: [],
      configuration: [],
      skills: [],
    })
    await entered.promise
    expect(store.read('thread').timeline.active.items).toEqual([])
    expect(store.read('thread').status).toBe('submitted')
    expect(store.read('thread').submissions[0]?.submittedAt).toBe(123)
    answer.resolve({ sessionId: 'session', promptId: 'server-id' })
    expect(await sending).toEqual({ sessionId: 'session', promptId: 'server-id' })
    expect(store.read('thread').promptId).toBe('server-id')
    expect(store.read('thread').timeline.active.items).toEqual([])
    store.dispose()
  })

  test('terminal waiters ignore the preceding completed turn', async () => {
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
    const preceding = officialTurn('preceding-turn', 'preceding-prompt', 7)
    store.route('session', 'thread', page('main', 0, { items: [preceding] }))
    let finished = false
    const waiting = store.waitForTerminal('thread', 'target-prompt').then((outcome) => {
      finished = true
      return outcome
    })
    const observed = new Promise<void>((resolve) => {
      const off = store.subscribe('thread', () => {
        if (store.read('thread').status === 'submitted') {
          off()
          resolve()
        }
      })
    })
    receive({
      kind: 'ops',
      sessionId: 'session',
      agentId: 'main',
      seq: 1,
      ops: [
        {
          op: 'reset',
          agentId: 'main',
          snapshot: page('main', 1, {
            items: [preceding],
            prompts: [
              { promptId: 'target-prompt', status: 'queued', createdAt: '2026-01-01T00:00:01Z' },
            ],
          }),
        },
      ],
    })
    await observed
    expect(finished).toBe(false)
    receive({
      kind: 'ops',
      sessionId: 'session',
      agentId: 'main',
      seq: 2,
      ops: [
        {
          op: 'reset',
          agentId: 'main',
          snapshot: page('main', 2, {
            items: [preceding, officialTurn('target-turn', 'target-prompt', 8)],
            prompts: [
              { promptId: 'target-prompt', status: 'completed', createdAt: '2026-01-01T00:00:01Z' },
            ],
          }),
        },
      ],
    })
    expect(await waiting).toBe('completed')
    store.dispose()
  })

  test('a failed cancellation does not invent a running state', async () => {
    const store = new TranscriptStore()
    store.ensure(
      sessionPort(transcriptPort(), {
        cancel: async () => {
          throw new Error('Cancellation refused')
        },
      }),
    )
    store.route(
      'session',
      'thread',
      page('main', 0, {
        items: [officialTurn('running-turn', 'running-prompt', 1, 'running')],
        interactions: [
          { interactionId: 'approval', interactionKind: 'approval', state: 'pending' },
        ],
      }),
    )
    const official = store.read('thread').timeline
    const failed = new Promise<void>((resolve) => {
      const off = store.subscribe('thread', () => {
        if (store.read('thread').operation.kind === 'failed') {
          off()
          resolve()
        }
      })
    })
    store.cancel('thread')
    expect(store.read('thread').status).toBe('cancelling')
    await failed
    expect(store.read('thread').timeline).toBe(official)
    expect(store.read('thread').status).toBe('awaiting_permission')
    store.dispose()
  })
})
