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
  DroppedPrompt,
  QueuedMessages,
  RunFailed,
} from '../../agent/session'
import type { TranscriptPage, TranscriptPort, TranscriptSignal } from '../../agent/transcript'
import { delegateKey } from '../../timeline/delegate-channel'
import { projectTranscript, promptOutcome } from '../transcript-projector'
import { TranscriptReplica } from '../transcript-replica'
import { canCancel, TranscriptStore } from '../transcript-store'

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
    readMedia: async () => ({ mediaType: 'image/png', base64: '' }),
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
    readQueue: async () => ({
      sessionId: 'session',
      steering: [],
      followUp: [],
      steeringMode: 'one-at-a-time',
      followUpMode: 'one-at-a-time',
      interruptMode: 'immediate',
    }),
    withdraw: async () => null,
    setDeliveryModes: async () => ({
      sessionId: 'session',
      steering: [],
      followUp: [],
      steeringMode: 'one-at-a-time',
      followUpMode: 'one-at-a-time',
      interruptMode: 'immediate',
    }),
    subscribeQueue: () => () => undefined,
    subscribePromptDropped: () => () => undefined,
    subscribeRunFailed: () => () => undefined,
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
      deliverAs: 'turn',
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
        deliverAs: 'turn',
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

  /*
   * 投递结果未确认：这一轮**可能还在跑**（回执正是没回来的那一样），所以停止键必须给得出来。
   * 这正是截图里的场景：omp 的 ask 工具把一轮卡在等人答题上，prompt 的应答永远不回来。
   */
  test('an indeterminate delivery still offers a stop, because the turn may be running', async () => {
    const port = sessionPort(transcriptPort(), {
      prompt: () => Promise.reject(new Error('投递结果未确认，请先核对会话；不要重复发送。')),
    })
    const store = new TranscriptStore()
    store.ensure(port)
    await store.send({
      deliverAs: 'turn',
      port,
      threadId: 'thread',
      text: 'hello',
      assets: [],
      configuration: [],
      skills: [],
    })

    const read = store.read('thread')
    expect(read.operation.kind === 'failed' && read.operation.indeterminate).toBe(true)
    /* 状态仍是「没成」，但那一轮可能还在跑 —— 停止键认的正是后者。 */
    expect(canCancel(read)).toBe(true)

    store.cancel('thread')
    expect(store.read('thread').operation.kind).toBe('cancelling')
    store.dispose()
  })

  /* 压根没出去的那一种：确定没有轮在跑，就不该给一颗按不出东西的停止键。 */
  test('a submission that never left the machine offers no stop', async () => {
    const store = new TranscriptStore()
    await store.send({
      deliverAs: 'turn',
      port: undefined,
      threadId: 'thread',
      text: 'hello',
      assets: [],
      configuration: [],
      skills: [],
    })

    const read = store.read('thread')
    expect(read.operation.kind === 'failed' && read.operation.indeterminate).toBe(false)
    expect(canCancel(read)).toBe(false)

    store.cancel('thread')
    expect(store.read('thread').operation.kind).toBe('failed')
    store.dispose()
  })

  /* 重发之后上一句失败必须走：它没有号（promptId 是 null），`#publish` 永远收不走它。 */
  test('a new submission clears the previous failure it supersedes', async () => {
    const store = new TranscriptStore()
    const base = {
      deliverAs: 'turn' as const,
      port: undefined,
      threadId: 'thread',
      assets: [],
      configuration: [],
      skills: [],
    }
    await store.send({ ...base, text: 'first' })
    expect(store.read('thread').submissions.map((entry) => entry.phase)).toEqual(['failed'])

    await store.send({ ...base, text: 'second' })
    const kept = store.read('thread').submissions
    expect(kept.map((entry) => entry.text)).toEqual(['second'])
    expect(kept.map((entry) => entry.phase)).toEqual(['failed'])
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
      deliverAs: 'turn',
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

describe('the agent-owned message queue', () => {
  test('views share an owner while conversations remain isolated', () => {
    const store = new TranscriptStore()
    const first = store.queue('first')
    const off = first.subscribe(() => undefined)
    off()
    expect(store.queue('first')).toBe(first)
    expect(store.queue('second')).not.toBe(first)
    store.forget('first')
    expect(() => first.withdraw()).toThrow('disposed')
    expect(store.queue('first')).not.toBe(first)
    store.dispose()
    expect(() => store.queue('first')).toThrow('disposed')
  })

  test('session replacement retires the replica, not its conversation queue', () => {
    const store = new TranscriptStore()
    store.ensure(sessionPort(transcriptPort()))
    const queue = store.queue('thread')
    store.route('session', 'thread', page())
    store.route('replacement', 'thread', page())
    expect(store.queue('thread')).toBe(queue)
    expect(store.ownerOf('session')).toBeUndefined()
    expect(store.ownerOf('replacement')).toBe('thread')
    store.dispose()
  })

  /* 队列归 agent：它报什么就画什么，这一侧不排第二份。 */
  test('a queue snapshot reaches the conversation that owns the session', () => {
    let push: (queue: QueuedMessages) => void = () => {
      throw new Error('Not subscribed.')
    }
    const store = new TranscriptStore()
    store.ensure(
      sessionPort(transcriptPort(), {
        subscribeQueue: (listener) => {
          push = listener
          return () => undefined
        },
      }),
    )
    store.route('session', 'thread', page())
    const queue = store.queue('thread')
    const seen: number[] = []
    queue.subscribe(() => seen.push(queue.read().steering.length))
    push({
      sessionId: 'session',
      steering: ['插一句'],
      followUp: ['排队的一句'],
      steeringMode: 'all',
      followUpMode: 'one-at-a-time',
      interruptMode: 'wait',
    })
    expect(queue.read().steering).toEqual(['插一句'])
    expect(queue.read().followUp).toEqual(['排队的一句'])
    expect(queue.read().interruptMode).toBe('wait')
    expect(seen).toEqual([1])

    /* 还没绑上对话的会话不认领：猜一个归属就是把 chip 画到别人的对话上。 */
    push({
      sessionId: 'other',
      steering: ['别人的'],
      followUp: [],
      steeringMode: 'all',
      followUpMode: 'all',
      interruptMode: 'immediate',
    })
    expect(queue.read().steering).toEqual(['插一句'])
    store.dispose()
  })

  /* 撤回是 LIFO 的 agent 动作：交回正文，队列由它自己报下一次。 */
  test('withdraw hands the last queued text back for the editor', async () => {
    const store = new TranscriptStore()
    store.ensure(
      sessionPort(transcriptPort(), {
        withdraw: async () => ({ text: '最后一句' }),
      }),
    )
    const queue = store.queue('thread')
    await expect(queue.withdraw()).resolves.toEqual({ text: '最后一句' })
    store.dispose()
  })

  /* 入队前被取消的那一句不会有任何帧；只能靠 setPromptDropped 那条事件收账。 */
  test('a dropped prompt fails its pending submission instead of vanishing', async () => {
    let dropped: (prompt: DroppedPrompt) => void = () => {
      throw new Error('Not subscribed.')
    }
    const store = new TranscriptStore()
    const port = sessionPort(transcriptPort(), {
      subscribePromptDropped: (listener) => {
        dropped = listener
        return () => undefined
      },
      prompt: () => new Promise(() => undefined),
    })
    store.ensure(port)
    /* 队列/掉单都是会话级事件：先认下这条会话属于哪条对话，收账才找得到人。 */
    store.route('session', 'thread', page())
    void store.send({
      deliverAs: 'turn',
      port,
      threadId: 'thread',
      text: '被取消的一句',
      assets: [],
      configuration: [],
      skills: [],
    })
    await Promise.resolve()
    dropped({ sessionId: 'session', text: '被取消的一句' })
    expect(store.read('thread').submissions.map((entry) => entry.phase)).toEqual(['failed'])
    expect(store.read('thread').operation.kind).toBe('failed')
    store.dispose()
  })

  /*
   * agent 中途死掉：屏幕上的轮终只认 agent 的 transcript，而 agent 已经死了。
   *
   * 那条通道再也不会有帧，所以本机必须自己把这一轮收掉 —— 不收的实测后果是：
   * 那一轮永远转下去，提交键变成「正在停止」然后消失，连发送键都没有，只能重启。
   */
  test('a locally detected run failure settles the turn instead of leaving it spinning', async () => {
    let failed: (run: RunFailed) => void = () => {
      throw new Error('Not subscribed.')
    }
    const store = new TranscriptStore()
    const port = sessionPort(transcriptPort(), {
      subscribeRunFailed: (listener) => {
        failed = listener
        return () => undefined
      },
      prompt: () => new Promise(() => undefined),
    })
    store.ensure(port)
    /* 页面里得真有一轮在跑：封条读的是 `active.run`，没有它这一格本来就是空的。 */
    store.route(
      'session',
      'thread',
      page('main', 0, { items: [officialTurn('running-turn', 'running-prompt', 1, 'running')] }),
    )
    void store.send({
      deliverAs: 'turn',
      port,
      threadId: 'thread',
      text: '还有一句在等回执',
      assets: [],
      configuration: [],
      skills: [],
    })
    await Promise.resolve()

    failed({
      sessionId: 'session',
      message: 'agent 连接已断开，本轮已终止，请重试',
      /* 真的失败了，不是掉帧那种。 */
      degraded: false,
    })

    /*
     * 屏幕必须真的**停下来**：`status` 不再是在飞的那几档。
     *
     * 这一条是本次修复的要害 —— 只收 `operation` 的话，转圈由 timeline 说了算，
     * 屏幕上照旧永远「正在处理」（实测过：提交键变成「正在停止」然后消失，只能重启）。
     */
    expect(canCancel(store.read('thread'))).toBe(false)
    expect(['submitted', 'running', 'cancelling']).not.toContain(store.read('thread').status)

    /*
     * 封条那一行也认这一格：它读的是 `active.run.settled`（timeline-contract 的
     * TurnPage.run）。不改的话屏幕上照旧「正在处理」，只有输入框那一栏知道出了事。
     */
    expect(store.read('thread').timeline.active.run?.settled).toBe(true)

    /* 提交收成失败（不再挂着「提交中」），并且原生侧那句话原样上屏。 */
    expect(store.read('thread').submissions.map((entry) => entry.phase)).toEqual(['failed'])
    expect(store.read('thread').operation).toEqual({
      kind: 'failed',
      message: 'agent 连接已断开，本轮已终止，请重试',
      blocks: false,
      indeterminate: false,
    })
    store.dispose()
  })

  /*
   * **本轮修复的要害**：本机那条「这一轮终止了」必须熬得过下一次投影。
   *
   * `timeline` 是 agent 快照的纯投影，`#publish` 每来一次快照就整块重算。把本机事实
   * 写进上一份 `timeline` 是**假修复**：下一次投影把它冲掉，屏幕退回「正在处理」。
   * 所以这条判据住在自己的一格里，并在投影之后就地补上。
   */
  test('a locally settled turn survives the next projection', async () => {
    let failed: (run: RunFailed) => void = () => {
      throw new Error('Not subscribed.')
    }
    let publish: (signal: TranscriptSignal) => void = () => {
      throw new Error('Not subscribed.')
    }
    /* reset 之后紧跟一条 ops：投影会被整块重算，本机那条事实必须还在。 */
    const store = new TranscriptStore()
    const replicaSettle = () => new Promise((resolve) => setTimeout(resolve, 20))
    /* `subscribeTranscript` 在 transcript 端口上，`subscribeRunFailed` 在会话端口上。 */
    const port = sessionPort(
      transcriptPort({
        subscribeTranscript: (listener) => {
          publish = listener
          return () => undefined
        },
        readTranscript: async (_session, agent) =>
          page(agent, 0, { items: [officialTurn('run-turn', 'run-prompt', 1, 'running')] }),
      }),
      {
        subscribeRunFailed: (listener) => {
          failed = listener
          return () => undefined
        },
      },
    )
    store.ensure(port)
    store.route(
      'session',
      'thread',
      page('main', 0, { items: [officialTurn('run-turn', 'run-prompt', 1, 'running')] }),
    )
    await Promise.resolve()

    expect(store.read('thread').status).toBe('running')

    failed({
      sessionId: 'session',
      message: 'agent 连接已断开，本轮已终止，请重试',
      /* 真的失败了，不是掉帧那种。 */
      degraded: false,
    })
    expect(store.read('thread').timeline.active.run?.settled).toBe(true)

    /* 再来一次投影（agent 已经死了，快照还是老样子）—— 收口必须还在。 */
    publish({ kind: 'reset', sessionId: 'session', agentId: 'main', seq: undefined })
    await replicaSettle()
    await Promise.resolve()
    expect(store.read('thread').timeline.active.run?.settled).toBe(true)
    expect(store.read('thread').status).toBe('failed')
    store.dispose()
  })

  /*
   * 收口只能管**那一次**失败，不能管这条会话的余生。
   *
   * 判据住在会话名下、不放掉，于是它会对这条会话**之后每一次投影**都生效 ——
   * 新一轮真的在跑（agent 又活了，快照里它就是 running）也会被强行收成「已处理」：
   * 转圈不出现、封条说已完成，而那一轮其实还在跑。
   */
  test('a later genuinely running turn is not mistaken for the failed one', async () => {
    let failed: (run: RunFailed) => void = () => {
      throw new Error('Not subscribed.')
    }
    let publish: (signal: TranscriptSignal) => void = () => {
      throw new Error('Not subscribed.')
    }
    const store = new TranscriptStore()
    const settle = () => new Promise((resolve) => setTimeout(resolve, 20))
    const port = sessionPort(
      transcriptPort({
        subscribeTranscript: (listener) => {
          publish = listener
          return () => undefined
        },
        /* 第二轮是**另一轮**：编号也必须不同，否则它本来就是同一轮。 */
        readTranscript: async (_session, agent) =>
          page(agent, 0, {
            items: [
              officialTurn('old-turn', 'old-prompt', 1, 'running'),
              officialTurn('new-turn', 'new-prompt', 2, 'running'),
            ],
          }),
      }),
      {
        subscribeRunFailed: (listener) => {
          failed = listener
          return () => undefined
        },
      },
    )
    store.ensure(port)
    store.route(
      'session',
      'thread',
      page('main', 0, { items: [officialTurn('old-turn', 'old-prompt', 1, 'running')] }),
    )
    await settle()
    failed({
      sessionId: 'session',
      message: 'agent 连接已断开，本轮已终止，请重试',
      /* 真的失败了，不是掉帧那种。 */
      degraded: false,
    })
    expect(store.read('thread').timeline.active.run?.settled).toBe(true)

    /* agent 回来了，**下一轮**真的在跑（另一轮，另一个编号）。 */
    publish({ kind: 'reset', sessionId: 'session', agentId: 'main', seq: undefined })
    await settle()
    expect(store.read('thread').timeline.active.run?.settled).toBe(false)
    expect(store.read('thread').status).toBe('running')
    store.dispose()
  })

  /*
   * 掉帧的那种「失败」不是失败：那一轮**跑完了**，只是我们自己的帧记录有损。
   *
   * 两者都要收尾（都不会再有帧了），但只有真失败该报错 —— 把内部诊断当横幅弹出去，
   * 跑完的一轮看起来就像崩了。
   */
  test('a lossy capture settles the turn without reporting a failure', async () => {
    let failed: (run: RunFailed) => void = () => {
      throw new Error('Not subscribed.')
    }
    const store = new TranscriptStore()
    const port = sessionPort(transcriptPort(), {
      subscribeRunFailed: (listener) => {
        failed = listener
        return () => undefined
      },
      prompt: () => new Promise(() => undefined),
    })
    store.ensure(port)
    store.route(
      'session',
      'thread',
      page('main', 0, { items: [officialTurn('lossy-turn', 'lossy-prompt', 1, 'running')] }),
    )
    const before = store.read('thread').operation

    failed({
      sessionId: 'session',
      message: 'the frame journal dropped 3 frames of this turn',
      degraded: true,
    })

    /* 收尾照做：那一轮结束了，转圈要停。 */
    expect(store.read('thread').timeline.active.run?.settled).toBe(true)
    /* 但不报错：内部诊断不该变成失败横幅。 */
    expect(store.read('thread').operation).toEqual(before)
    store.dispose()
  })

  /* 不属于这条对话的会话号不该动它：与掉单同一条理由（按号认领）。 */
  test('a run failure for another session leaves this conversation alone', async () => {
    let failed: (run: RunFailed) => void = () => {
      throw new Error('Not subscribed.')
    }
    const store = new TranscriptStore()
    const port = sessionPort(transcriptPort(), {
      subscribeRunFailed: (listener) => {
        failed = listener
        return () => undefined
      },
      prompt: () => new Promise(() => undefined),
    })
    store.ensure(port)
    store.route('session', 'thread', page())
    void store.send({
      deliverAs: 'turn',
      port,
      threadId: 'thread',
      text: '等着',
      assets: [],
      configuration: [],
      skills: [],
    })
    await Promise.resolve()

    failed({
      sessionId: 'another-session',
      message: 'agent 连接已断开，本轮已终止，请重试',
      degraded: false,
    })

    expect(store.read('thread').submissions.map((entry) => entry.phase)).toEqual(['submitting'])
    store.dispose()
  })

  /* 打了同一句话的是另一条对话：掉单带号，就不该被它认领。 */
  test('a dropped prompt never fails another conversation that said the same thing', async () => {
    let dropped: (prompt: DroppedPrompt) => void = () => {
      throw new Error('Not subscribed.')
    }
    const store = new TranscriptStore()
    const port = sessionPort(transcriptPort(), {
      subscribePromptDropped: (listener) => {
        dropped = listener
        return () => undefined
      },
      prompt: () => new Promise(() => undefined),
    })
    store.ensure(port)
    store.route('mine', 'mine', page())
    store.route('theirs', 'theirs', page())
    void store.send({
      deliverAs: 'turn',
      port,
      threadId: 'mine',
      text: '同一句话',
      assets: [],
      configuration: [],
      skills: [],
    })
    await Promise.resolve()
    dropped({ sessionId: 'theirs', text: '同一句话' })
    expect(store.read('mine').submissions.map((entry) => entry.phase)).toEqual(['submitting'])
    expect(store.read('mine').operation.kind).not.toBe('failed')
    store.dispose()
  })
  test('question failures are recorded by the domain and propagated to the caller', async () => {
    const cause = new Error('Question was not dismissed')
    const store = new TranscriptStore()
    store.ensure(
      sessionPort(transcriptPort(), {
        dismissQuestions: async () => {
          throw cause
        },
      }),
    )
    await expect(store.dismissQuestions('thread', 'question')).rejects.toBe(cause)
    expect(store.read('thread').operation.kind).toBe('failed')
    store.dispose()
  })
})

describe('transcript recovery ownership', () => {
  test('a reset retires pending reads and accepts a smaller cursor without clearing the view', async () => {
    const entered = deferred<void>()
    const recovering = deferred<void>()
    const pending = deferred<TranscriptPage>()
    const restored = deferred<TranscriptPage>()
    let reads = 0
    let catches = 0
    const publications: AgentTranscriptSnapshot[] = []
    const replica = new TranscriptReplica(
      'session',
      transcriptPort({
        readTranscript: () => {
          reads += 1
          if (reads === 1) {
            entered.resolve()
            return pending.promise
          }
          recovering.resolve()
          return restored.promise
        },
        catchUpTranscript: async (_session, agent, seq) => {
          catches += 1
          return { agentId: agent, batches: [], latestSeq: seq, complete: true }
        },
      }),
      (_agent, snapshot) => publications.push(snapshot),
    )
    const running = officialTurn('turn-1', 'prompt-1', 1, 'running')
    const completed = { ...running, state: 'completed' as const }
    replica.seed(page('main', 40, { items: [running] }))
    const inFlight = replica.refresh('main')
    await entered.promise
    const reset = replica.receive({
      kind: 'reset',
      sessionId: 'session',
      agentId: 'main',
      seq: undefined,
    })
    await recovering.promise
    replica.seed(page('main', 80, { items: [running] }))
    expect(replica.snapshot('main')?.items).toEqual([running])
    restored.resolve(page('main', 2, { items: [completed] }))
    await reset
    await replica.receive(ops('main', 3))
    pending.resolve(page('main', 99, { items: [running] }))
    await inFlight
    expect(replica.snapshot('main')?.items).toEqual([completed])
    expect(publications).toHaveLength(2)
    expect(reads).toBe(2)
    expect(catches).toBe(0)
    replica.dispose()
  })

  test('restores the loaded history boundary before publishing recovery', async () => {
    const first = officialTurn('turn-1', 'prompt-1', 1)
    const second = officialTurn('turn-2', 'prompt-2', 2)
    const third = officialTurn('turn-3', 'prompt-3', 3)
    const requests: (string | undefined)[] = []
    const publications: AgentTranscriptSnapshot[] = []
    const replica = new TranscriptReplica(
      'session',
      transcriptPort({
        readTranscript: async (_session, agent, before) => {
          requests.push(before)
          if (before === undefined) {
            return page(agent, 1, { items: [third], hasMoreOlder: true })
          }
          if (before === third.turnId) {
            return page(agent, 1, { items: [second], hasMoreOlder: true })
          }
          if (before === second.turnId) {
            return page(agent, 1, { items: [first], hasMoreOlder: false })
          }
          throw new Error('Unexpected history boundary.')
        },
      }),
      (_agent, snapshot) => publications.push(snapshot),
    )
    replica.seed(page('main', 40, { items: [first, second] }))
    await replica.receive({ kind: 'reset', sessionId: 'session', agentId: 'main', seq: undefined })
    expect(requests).toEqual([undefined, third.turnId, second.turnId])
    expect(replica.snapshot('main')?.items).toEqual([first, second, third])
    expect(publications).toHaveLength(2)
    replica.dispose()
  })

  test('global recovery discovers agents from the refreshed authoritative roster', async () => {
    const reads: string[] = []
    const replica = new TranscriptReplica(
      'session',
      transcriptPort({
        readTranscript: async (_session, agent) => {
          reads.push(agent)
          return page(agent, 1)
        },
      }),
      () => undefined,
    )
    replica.seed(page('main', 40, { agents: [{ agentId: 'main', type: 'main' }] }))
    await replica.receive({ kind: 'resync', sessionId: 'session', reason: 'session_recreated' })
    expect(reads).toEqual(['main', 'worker'])
    expect(replica.snapshot('worker')).toBeDefined()
    replica.dispose()
  })

  test('a smaller upstream watermark starts a fresh recovery owner', async () => {
    let catches = 0
    let heads = 0
    const replica = new TranscriptReplica(
      'session',
      transcriptPort({
        catchUpTranscript: async (_session, agent) => {
          catches += 1
          return { agentId: agent, batches: [], latestSeq: 1, complete: false }
        },
        readTranscript: async (_session, agent) => {
          heads += 1
          return page(agent, 1)
        },
      }),
      () => undefined,
    )
    replica.seed(page('main', 40))
    await replica.synchronize('main')
    await replica.receive(ops('main', 2))
    expect(catches).toBe(1)
    expect(heads).toBe(1)
    replica.dispose()
  })

  test('opening snapshots cannot overwrite an already recovered generation', async () => {
    const running = officialTurn('turn-1', 'prompt-1', 1, 'running')
    const completed = { ...running, state: 'completed' as const }
    let catches = 0
    const replica = new TranscriptReplica(
      'session',
      transcriptPort({
        readTranscript: async (_session, agent) => page(agent, 1, { items: [completed] }),
        catchUpTranscript: async (_session, agent, seq) => {
          catches += 1
          return { agentId: agent, batches: [], latestSeq: seq, complete: true }
        },
      }),
      () => undefined,
    )
    replica.seed(page('main', 40, { items: [running] }))
    await replica.receive({ kind: 'reset', sessionId: 'session', agentId: 'main', seq: undefined })
    replica.seed(page('main', 99, { items: [running] }))
    await replica.receive(ops('main', 2))
    expect(replica.snapshot('main')?.items).toEqual([completed])
    expect(catches).toBe(0)
    replica.dispose()
  })

  /*
   * reset 自报的水位就是我们的水位时，中间没有待补的帧 —— 再整读一次 head 只会拿回
   * 同一份正文。冷会话（server 内存里没有的旧对话）恒走这一档：本机 180 条对话里
   * 178 条是这个形状，正文 400–600 KB，多读一次就是白花一次全文往返。
   */
  test('a reset at our own watermark does not refetch the page we already hold', async () => {
    let heads = 0
    let catches = 0
    const replica = new TranscriptReplica(
      'session',
      transcriptPort({
        readTranscript: async (_session, agent) => {
          heads += 1
          return page(agent, 5)
        },
        catchUpTranscript: async (_session, agent) => {
          catches += 1
          return { agentId: agent, batches: [], latestSeq: 5, complete: false }
        },
      }),
      () => undefined,
    )
    replica.seed(page('main', 5))
    await replica.synchronize('main')
    /* synchronize 的 catch-up 连一帧都没有，且与手上那一页同水位：不读 head。 */
    expect(catches).toBe(1)
    expect(heads).toBe(0)

    await replica.receive({ kind: 'reset', sessionId: 'session', agentId: 'main', seq: 5 })
    expect(heads).toBe(0)
    /* 换了一代，但视图还在：位次照旧推进。 */
    await replica.receive(ops('main', 6))
    expect(replica.snapshot('main')).toBeDefined()
    replica.dispose()
  })

  /* 水位比我们新的时候，中间那些帧只有 REST 补得回来，不能省。 */
  test('a reset ahead of our watermark still recovers over REST', async () => {
    let heads = 0
    const replica = new TranscriptReplica(
      'session',
      transcriptPort({
        readTranscript: async (_session, agent) => {
          heads += 1
          return page(agent, 9)
        },
      }),
      () => undefined,
    )
    replica.seed(page('main', 5))
    await replica.receive({ kind: 'reset', sessionId: 'session', agentId: 'main', seq: 9 })
    expect(heads).toBe(1)
    replica.dispose()
  })

  /* 水位未知（server 没报）时只能照旧去读：猜一个水位就是拿旧正文冒充新事实。 */
  test('an unknown reset watermark still recovers over REST', async () => {
    let heads = 0
    const replica = new TranscriptReplica(
      'session',
      transcriptPort({
        readTranscript: async (_session, agent) => {
          heads += 1
          return page(agent, 5)
        },
      }),
      () => undefined,
    )
    replica.seed(page('main', 5))
    await replica.receive({ kind: 'reset', sessionId: 'session', agentId: 'main', seq: undefined })
    expect(heads).toBe(1)
    replica.dispose()
  })

  test('watermark rollback propagates a failure from the successor recovery', async () => {
    const replica = new TranscriptReplica(
      'session',
      transcriptPort({
        catchUpTranscript: async (_session, agent) => ({
          agentId: agent,
          batches: [],
          latestSeq: 1,
          complete: false,
        }),
        readTranscript: async () => {
          throw new Error('Successor recovery unavailable.')
        },
      }),
      () => undefined,
    )
    replica.seed(page('main', 40))
    await expect(replica.synchronize('main')).rejects.toThrow('Successor recovery unavailable.')
    replica.dispose()
  })

  test('a retired read failure cannot fail the recovered owner', async () => {
    const entered = deferred<void>()
    const release = deferred<void>()
    let reads = 0
    const replica = new TranscriptReplica(
      'session',
      transcriptPort({
        readTranscript: async (_session, agent) => {
          reads += 1
          if (reads === 1) {
            entered.resolve()
            await release.promise
            throw new Error('Retired request failed.')
          }
          return page(agent, 1)
        },
      }),
      () => undefined,
    )
    replica.seed(page('main', 40))
    const pending = replica.refresh('main')
    await entered.promise
    await replica.receive({ kind: 'reset', sessionId: 'session', agentId: 'main', seq: undefined })
    release.resolve()
    await pending
    expect(reads).toBe(2)
    expect(replica.snapshot('main')).toBeDefined()
    replica.dispose()
  })

  test('failed offset recovery never exposes an accepted prefix', async () => {
    const committed = page('main', 4)
    const replica = new TranscriptReplica(
      'session',
      transcriptPort({
        readTranscript: async () => {
          throw new Error('Recovery unavailable.')
        },
      }),
      () => undefined,
    )
    replica.seed(committed)
    await expect(
      replica.receive({
        kind: 'ops',
        sessionId: 'session',
        agentId: 'main',
        seq: 5,
        ops: [
          {
            op: 'prompt.upsert',
            prompt: {
              promptId: 'target',
              status: 'completed',
              createdAt: '2026-01-01T00:00:00Z',
            },
          },
          { op: 'append', target: { type: 'task', taskId: 'missing' }, offset: 10, text: 'gap' },
        ],
      }),
    ).rejects.toThrow('Recovery unavailable.')
    expect(replica.snapshot('main')?.prompts).toEqual(committed.prompts)
    expect(replica.snapshot('main')?.tasks).toEqual(committed.tasks)
    replica.dispose()
  })

  test('an incomplete catch-up cannot commit its prefix when the head request fails', async () => {
    const replica = new TranscriptReplica(
      'session',
      transcriptPort({
        catchUpTranscript: async (_session, agent) => ({
          agentId: agent,
          latestSeq: 6,
          complete: true,
          batches: [
            {
              seq: 5,
              ops: [
                {
                  op: 'prompt.upsert',
                  prompt: {
                    promptId: 'target',
                    status: 'completed',
                    createdAt: '2026-01-01T00:00:00Z',
                  },
                },
              ],
            },
          ],
        }),
        readTranscript: async () => {
          throw new Error('Recovery unavailable.')
        },
      }),
      () => undefined,
    )
    replica.seed(page('main', 4))
    await expect(replica.synchronize('main')).rejects.toThrow('Recovery unavailable.')
    expect(replica.snapshot('main')?.prompts).toEqual([])
    replica.dispose()
  })

  test('non-advancing history fails without publishing a partial window', async () => {
    const first = officialTurn('turn-1', 'prompt-1', 1)
    const latest = officialTurn('turn-3', 'prompt-3', 3)
    const replica = new TranscriptReplica(
      'session',
      transcriptPort({
        readTranscript: async (_session, agent) =>
          page(agent, 1, { items: [latest], hasMoreOlder: true }),
      }),
      () => undefined,
    )
    replica.seed(page('main', 40, { items: [first] }))
    await expect(
      replica.receive({ kind: 'reset', sessionId: 'session', agentId: 'main', seq: undefined }),
    ).rejects.toThrow('Transcript pagination did not advance.')
    expect(replica.snapshot('main')?.items).toEqual([first])
    replica.dispose()
  })

  test('empty live and catch-up batches advance the cursor without publishing', async () => {
    const cursors: number[] = []
    let published = 0
    const replica = new TranscriptReplica(
      'session',
      transcriptPort({
        catchUpTranscript: async (_session, agent, seq) => {
          cursors.push(seq)
          return {
            agentId: agent,
            batches: [{ seq: seq + 1, ops: [] }],
            latestSeq: seq + 1,
            complete: true,
          }
        },
      }),
      () => {
        published += 1
      },
    )
    replica.seed(page('main', 4))
    const seeded = published
    await replica.receive(ops('main', 5))
    await replica.synchronize('main')
    await replica.receive(ops('main', 7))
    expect(cursors).toEqual([5])
    expect(published).toBe(seeded)
    replica.dispose()
  })

  test('a subagent reset failure belongs to its subagent channel', async () => {
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
          readTranscript: async () => {
            throw new Error('Worker recovery unavailable.')
          },
        }),
      ),
    )
    store.route('session', 'thread', page())
    const key = delegateKey('thread', 'worker')
    const failed = new Promise<void>((resolve) => {
      const off = store.subscribe(key, () => {
        if (store.read(key).operation.kind === 'failed') {
          off()
          resolve()
        }
      })
    })
    receive({ kind: 'reset', sessionId: 'session', agentId: 'worker', seq: undefined })
    await failed
    expect(store.read('thread').operation.kind).toBe('ready')
    expect(store.read(key).operation.kind).toBe('failed')
    store.dispose()
  })
})

/*
 * 历史图片的代取只认「这一页引用到的附件」。
 *
 * 发布是每帧一次（流式 delta 也走这条路），而附件表是整条会话累积的。全量扫的代价与
 * 「这条会话发过多少张图」成正比 —— 判据是：没被任何一轮引用的附件一次都不该去取。
 */
describe('historical media is fetched only for attachments the page references', () => {
  test('an unreferenced image is never fetched, a referenced one is fetched once', async () => {
    const asked: string[] = []
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
          readMedia: async (_session, fileId) => {
            asked.push(fileId)
            return { mediaType: 'image/png', base64: 'AAAA' }
          },
        }),
      ),
    )
    const referenced = (fileId: string) => ({
      attachmentId: `img-${fileId}`,
      mediaType: 'image/png',
      name: 'shot.png',
      size: 4,
      source: { kind: 'session_media' as const, fileId },
    })
    const pageWith = (ids: readonly string[]) =>
      page('main', 0, {
        items: [{ ...officialTurn('t1', 'p1', 1), attachmentIds: ids.map((id) => `img-${id}`) }],
        attachments: [
          referenced('wanted'),
          referenced('unreferenced'),
          ...ids.map((id) => referenced(id)),
        ],
      })
    store.route('session', 'thread', pageWith(['wanted']))
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(asked).toEqual(['wanted'])

    /* 再发布几次（流式每帧都走这条路）：已取到的不重取，没引用的也不去取。 */
    for (let seq = 1; seq <= 3; seq += 1) {
      receive({
        kind: 'ops',
        sessionId: 'session',
        agentId: 'main',
        seq,
        ops: [{ op: 'meta.merge', meta: { activity: seq % 2 === 0 ? 'turn' : 'idle' } }],
      })
    }
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(asked).toEqual(['wanted'])
    store.dispose()
  })
})

describe('turn attachments projection', () => {
  const turnWith = (attachmentIds: readonly string[], prompt?: string): TranscriptTurn => ({
    ...officialTurn('attach-turn', 'attach-prompt', 1),
    ...(prompt === undefined ? {} : { prompt }),
    attachmentIds: [...attachmentIds],
  })

  test('a generic file becomes a file card and never message text', () => {
    const snapshot = page('main', 0, {
      items: [turnWith(['doc'], '看一下')],
      attachments: [
        { attachmentId: 'doc', mediaType: 'text/plain', name: 'notes.txt', size: 23440 },
      ],
    })
    const items = projectTranscript(snapshot).active.items
    const user = items.find((item) => item.type === 'user_message')
    expect(user).toMatchObject({
      type: 'user_message',
      text: '看一下',
      files: [{ name: 'notes.txt', meta: 'TXT 22.89KB' }],
    })
    expect(user && 'images' in user ? user.images : undefined).toBeUndefined()
  })

  test('an attachment-only turn still opens a user bubble anchor', () => {
    const snapshot = page('main', 0, {
      items: [turnWith(['doc'])],
      attachments: [
        { attachmentId: 'doc', mediaType: 'application/zip', name: 'bundle.zip', size: 512 },
      ],
    })
    const items = projectTranscript(snapshot).active.items
    expect(items.some((item) => item.type === 'user_message')).toBe(true)
  })

  test('the agent’s attachment notice never reaches the bubble', () => {
    const notice =
      'Attached file "notes.txt" (text/plain, 22 bytes): ' +
      'C:\\Users\\someone\\attachments\\ab\\abc — open it with the Read tool'
    const snapshot = page('main', 0, {
      items: [turnWith(['doc'], `看一下${notice}`)],
      attachments: [{ attachmentId: 'doc', mediaType: 'text/plain', name: 'notes.txt', size: 22 }],
    })
    const user = projectTranscript(snapshot).active.items.find(
      (item) => item.type === 'user_message',
    )
    expect(user).toMatchObject({ text: '看一下', files: [{ name: 'notes.txt' }] })
  })

  test('an image the agent gave no source for is a card, not a spinner forever', () => {
    const snapshot = page('main', 0, {
      items: [turnWith(['shot'])],
      attachments: [{ attachmentId: 'shot', mediaType: 'image/png', name: 'shot.png', size: 4 }],
    })
    const user = projectTranscript(snapshot).active.items.find(
      (item) => item.type === 'user_message',
    )
    expect(user).toMatchObject({ files: [{ name: 'shot.png', meta: 'PNG 4B' }] })
    expect(user && 'images' in user ? user.images : undefined).toBeUndefined()
  })

  test('a historical image stays a placeholder until its bytes are resolved', () => {
    const turn = turnWith(['img'])
    const snapshotPage = () =>
      page('main', 0, {
        items: [turn],
        attachments: [
          {
            attachmentId: 'img',
            mediaType: 'image/png',
            name: 'shot.png',
            size: 4,
            source: { kind: 'session_media', fileId: 'media-1' },
          },
        ],
      })
    const pending = projectTranscript(snapshotPage()).active.items
    expect(pending.find((item) => item.type === 'user_message')).toMatchObject({
      images: [{ pending: true }],
    })

    const resolved = projectTranscript(
      snapshotPage(),
      new Map([['media-1', 'data:image/png;base64,AAAA']]),
    ).active.items
    expect(resolved.find((item) => item.type === 'user_message')).toMatchObject({
      images: [{ url: 'data:image/png;base64,AAAA' }],
    })
  })
})
