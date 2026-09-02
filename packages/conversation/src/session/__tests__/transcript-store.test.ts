import { describe, expect, it } from 'bun:test'
import type { AgentSessionPort, RunEvent } from '../../agent'
import { TranscriptStore } from '../transcript-store'

/* 一条假线路：帧从哪来不重要，重要的是它带着哪条会话号。 */
function fakePort(
  cancel: AgentSessionPort['cancel'] = () => Promise.resolve(),
  prompt: AgentSessionPort['prompt'] = () => Promise.resolve({ sessionId: 'sess_a' }),
): {
  readonly port: AgentSessionPort
  readonly emit: (events: readonly RunEvent[], sessionId: string) => void
} {
  const listeners = new Set<(events: readonly RunEvent[], sessionId: string) => void>()

  return {
    port: {
      subscribe: (listener) => {
        listeners.add(listener)

        return () => {
          listeners.delete(listener)
        }
      },
      prompt,
      cancel,
      resolvePermission: () => Promise.resolve(),
      answerQuestions: () => Promise.resolve(),
      dismissQuestions: () => Promise.resolve(),
      steer: () => Promise.resolve(),
      abortPrompt: () => Promise.resolve(),
    },
    emit: (events, sessionId) => {
      for (const listener of listeners) {
        listener(events, sessionId)
      }
    },
  }
}

function started(seq: number, sessionId: string, admissionId = 'adm'): RunEvent {
  return { kind: 'prompt_admitted', admissionId, seq, at: seq, sessionId, prompt: '在吗' }
}

/* 一段流式文本。 */
function chunk(seq: number, text: string): RunEvent {
  return { kind: 'kap_event', seq, at: seq, payload: { type: 'assistant.delta', delta: text } }
}

/* 屏幕的节拍归用例掌握：攒下的通知什么时候发出去，由它说了算。 */
function painted(): { readonly store: TranscriptStore; readonly paint: () => void } {
  const waiting: Array<() => void> = []

  return {
    store: new TranscriptStore({
      paint: (flush) => {
        waiting.push(flush)
      },
    }),
    paint: () => {
      for (const flush of waiting.splice(0)) {
        flush()
      }
    },
  }
}

describe('transcript store', () => {
  /* 身份由调用方铸好；两个实例对同一个 id 各持各的账，互不串线。 */
  it('keeps two stores apart', () => {
    const one = new TranscriptStore({ paint: () => {} })
    const other = new TranscriptStore({ paint: () => {} })

    one.send({
      port: undefined,
      threadId: 'thread_a',
      text: '在吗',
      assets: [],
      configuration: [],
      skills: [],
    })

    expect(one.read('thread_a').timeline.status).toBe('failed')
    expect(other.read('thread_a').timeline.status).not.toBe('failed')
  })

  it('shows what was said even when there is nowhere to send it', () => {
    const { store, paint } = painted()
    let told = 0

    store.subscribe('thread_a', () => {
      told += 1
    })

    store.send({
      port: undefined,
      threadId: 'thread_a',
      text: '在吗',
      assets: [],
      configuration: [],
      skills: [],
    })

    /* 状态是同步的：说出去和记下事故都已经在里面了。 */
    const { timeline } = store.read('thread_a')

    expect(timeline.active.items.map((item) => item.type)).toEqual(['user_message', 'error'])
    expect(timeline.status).toBe('failed')

    /* 通知按节拍：同一拍里的两次改动，界面只需要被叫醒一次。 */
    expect(told).toBe(0)
    paint()
    expect(told).toBe(1)
  })

  it('把帧交给持有这条会话的那条对话', () => {
    const { store, paint } = painted()
    const { port, emit } = fakePort()

    store.ensure(port)
    store.route('sess_a', 'thread_a')
    store.route('sess_b', 'thread_b')

    const untouched = store.read('thread_a')

    emit([started(1, 'sess_b')], 'sess_b')
    paint()

    expect(store.read('thread_a')).toBe(untouched)
    expect(store.read('thread_b')).not.toBe(untouched)
  })

  it('没有登记过的会话，它的帧就地丢掉', () => {
    const { store, paint } = painted()
    const { port, emit } = fakePort()

    store.ensure(port)
    store.route('sess_a', 'thread_a')

    const untouched = store.read('thread_a')

    emit([started(1, 'sess_x')], 'sess_x')
    paint()

    /* 不排队、不补投、不占内存：地址先于帧到达，等待没有意义。 */
    expect(store.read('thread_a')).toBe(untouched)
  })

  it('一轮结束不会带走这条会话的地址', () => {
    const { store, paint } = painted()
    const { port, emit } = fakePort()

    store.ensure(port)
    store.route('sess_a', 'thread_a')

    emit([started(1, 'sess_a')], 'sess_a')
    emit([{ kind: 'run_finished', seq: 2, at: 2, stopReason: 'completed' }], 'sess_a')
    paint()

    const ended = store.read('thread_a')

    /* 会话跨轮存活。此前这里是按轮次记的，第二轮的帧会变成无主的。 */
    emit([started(3, 'sess_a')], 'sess_a')
    paint()

    expect(store.read('thread_a')).not.toBe(ended)
  })

  it('向上续读每次只取一页完整轮次', async () => {
    let reads = 0
    const store = new TranscriptStore({
      paint: () => {},
      reads: {
        earlier: () => {
          reads += 1
          return Promise.resolve({
            events: [started(1, 'sess_a'), chunk(2, '旧')],
            before: null,
          })
        },
        outline: () => Promise.resolve([]),
      },
    })

    store.adopt('thread_a', {
      events: [started(3, 'sess_a'), chunk(4, '新')],
      before: { sessionId: 'sess_a', seq: 3 },
    })
    await store.readEarlier('thread_a')

    const transcript = store.read('thread_a')
    const items = [
      ...transcript.timeline.sealed.flatMap((page) => page.items),
      ...transcript.timeline.active.items,
    ]

    expect(reads).toBe(1)
    expect(transcript.earlier).toBeNull()
    expect(items.filter((item) => item.type === 'user_message')).toHaveLength(2)
  })

  it('目录跳转复用有界分页器并吸收快速重入', async () => {
    let releaseFirst: (() => void) | undefined
    let calls = 0
    let inFlight = 0
    let maxInFlight = 0
    const cursors: number[] = []
    const pages = [
      {
        events: [started(5, 'sess_a', 'middle'), chunk(6, '中')],
        before: { sessionId: 'sess_a', seq: 5 },
      },
      {
        events: [started(1, 'sess_a', 'oldest'), chunk(2, '旧')],
        before: null,
      },
    ]
    const store = new TranscriptStore({
      paint: () => {},
      reads: {
        earlier: async (_threadId, before) => {
          const page = pages[calls]
          if (page === undefined) {
            throw new Error('unexpected extra history page')
          }
          calls += 1
          cursors.push(before.seq)
          inFlight += 1
          maxInFlight = Math.max(maxInFlight, inFlight)
          if (calls === 1) {
            await new Promise<void>((resolve) => {
              releaseFirst = resolve
            })
          }
          inFlight -= 1
          return page
        },
        outline: () => Promise.resolve([]),
      },
    })

    store.adopt('thread_a', {
      events: [started(9, 'sess_a', 'latest'), chunk(10, '新')],
      before: { sessionId: 'sess_a', seq: 9 },
    })

    const first = store.revealTurn('thread_a', {
      at: { sessionId: 'sess_a', seq: 5 },
      admissionId: 'middle',
      prompt: '中',
      reply: null,
    })
    const second = store.revealTurn('thread_a', {
      at: { sessionId: 'sess_a', seq: 1 },
      admissionId: 'oldest',
      prompt: '旧',
      reply: null,
    })

    expect(second).toBe(first)
    expect(store.read('thread_a').revealing).toBe('oldest')
    releaseFirst?.()
    await first

    const transcript = store.read('thread_a')
    const items = [
      ...transcript.timeline.sealed.flatMap((page) => page.items),
      ...transcript.timeline.active.items,
    ]
    expect(cursors).toEqual([9, 5])
    expect(maxInFlight).toBe(1)
    expect(transcript.reading).toBe(false)
    expect(transcript.revealing).toBeNull()
    expect(items.filter((item) => item.type === 'user_message')).toHaveLength(3)
  })

  it('coalesces outline invalidations into one suffix catch-up', async () => {
    const calls: Array<number | null> = []
    const answers: Array<(marks: readonly import('../../agent').TurnMark[]) => void> = []
    const store = new TranscriptStore({
      paint: () => {},
      reads: {
        earlier: () => Promise.reject(new Error('unused')),
        outline: (_threadId, fromSeq) => {
          calls.push(fromSeq)
          return new Promise((resolve) => answers.push(resolve))
        },
      },
    })
    const first = {
      admissionId: 'first',
      at: { sessionId: 'sess_a', seq: 1 },
      prompt: 'first',
      reply: null,
    } as const
    const second = {
      admissionId: 'second',
      at: { sessionId: 'sess_a', seq: 5 },
      prompt: 'second',
      reply: 'done',
    } as const

    store.opening('thread_a')
    store.opening('thread_a')
    await Promise.resolve()

    expect(calls).toEqual([null])
    answers.shift()?.([first])
    await Promise.resolve()
    await Promise.resolve()
    expect(calls).toEqual([null, 1])
    answers.shift()?.([{ ...first, reply: 'updated' }, second])
    await Promise.resolve()
    await Promise.resolve()

    expect(store.read('thread_a').outline).toEqual([{ ...first, reply: 'updated' }, second])
  })

  it('does not revive a forgotten transcript when an outline read fails', async () => {
    let reject: ((cause: unknown) => void) | undefined
    const store = new TranscriptStore({
      paint: () => {},
      reads: {
        earlier: () => Promise.reject(new Error('unused')),
        outline: () =>
          new Promise((_resolve, fail) => {
            reject = fail
          }),
      },
    })

    store.opening('thread_a')
    store.forget('thread_a')
    reject?.(new Error('late failure'))
    await Promise.resolve()
    await Promise.resolve()

    expect(store.read('thread_a').outline).toEqual([])
    expect(store.read('thread_a').timeline.active.items).toEqual([])
  })

  it('cancels before the thread is prepared', async () => {
    const { store, paint } = painted()
    let release: ((ready: boolean) => void) | undefined
    let prompts = 0
    const { port } = fakePort(undefined, () => {
      prompts += 1

      return Promise.resolve({ sessionId: 'sess_a' })
    })

    store.send({
      port,
      threadId: 'thread_a',
      text: '在吗',
      assets: [],
      configuration: [],
      skills: [],
      prepare: () =>
        new Promise<boolean>((resolve) => {
          release = resolve
        }),
    })
    store.cancel('thread_a')
    release?.(true)
    await Promise.resolve()
    await Promise.resolve()
    paint()

    expect(prompts).toBe(0)
    expect(store.read('thread_a').timeline.status).toBe('cancelled')
  })

  it('records a cancellation rejection instead of swallowing it', async () => {
    const { store, paint } = painted()
    const { port, emit } = fakePort(() => Promise.reject(new Error('stop refused')))

    store.ensure(port)
    store.route('sess_a', 'thread_a')
    /* 没在跑的轮次没有可取消的对象：先让一轮开起来，取消才到得了线路上。 */
    emit([started(1, 'sess_a')], 'sess_a')
    store.cancel('thread_a')
    await Promise.resolve()
    await Promise.resolve()
    paint()

    expect(store.read('thread_a').timeline.active.items.at(-1)).toMatchObject({
      type: 'error',
      message: 'Error: stop refused',
    })
  })

  it('一拍里来两百段文字，界面只被叫醒一次', () => {
    const { store, paint } = painted()
    const { port, emit } = fakePort()
    let told = 0

    store.ensure(port)
    store.route('sess_a', 'thread_a')
    store.subscribe('thread_a', () => {
      told += 1
    })

    const before = store.read('thread_a')

    emit([started(1, 'sess_a')], 'sess_a')

    const flurry: RunEvent[] = []

    for (let seq = 2; seq <= 201; seq += 1) {
      flurry.push(chunk(seq, '字'))
    }

    /* 两百段文字是一批送到的，与原生侧一拍攒下的那一批同形。 */
    emit(flurry, 'sess_a')

    /* 读是纯的：这一拍还没到，快照就一动不动，界面也还没被叫醒。 */
    expect(store.read('thread_a')).toBe(before)
    expect(told).toBe(0)

    paint()

    /* 一帧都没丢：两百零一帧一趟折完，而屏幕只被要求画一次。 */
    expect(store.read('thread_a').timeline.lastSeq).toBe(201)
    expect(told).toBe(1)
  })
})
