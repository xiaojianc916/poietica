import { describe, expect, it } from 'bun:test'
import type {
  OpenedThread,
  SessionConfigControl,
  SessionConfigPort,
  SessionConfigReport,
  ThreadPort,
  ThreadSnapshot,
} from '../../agent'

import { SessionControlsStore } from '../session-controls-store'
import type { TranscriptSink } from '../transcript-sink'

/*
 * 一条对话的那张表，只认一个端口：不认识 React、不认识进程、也不认识 IPC。
 */

const THREAD = 'thread-1'
const SESSION = 'session-1'

function routeSink(): TranscriptSink {
  const owners = new Map<string, string>()
  return {
    opening: () => undefined,
    adopt: () => undefined,
    history: () => undefined,
    failed: () => undefined,
    route: (sessionId, threadId) => {
      owners.set(sessionId, threadId)
    },
    ownerOf: (sessionId) => owners.get(sessionId),
    forget: (threadId) => {
      for (const [sessionId, owner] of owners) {
        if (owner === threadId) {
          owners.delete(sessionId)
        }
      }
    },
  }
}

const control = (
  id: string,
  purpose: SessionConfigControl['purpose'],
  current: string,
  values: readonly string[],
): SessionConfigControl => ({
  id,
  label: id,
  purpose,
  current,
  choices: values.map((value) => ({ value, label: value })),
})

/* 档位候选属于模型：前一个模型有 low，后一个没有。 */
const WITH_LOW: readonly SessionConfigControl[] = [
  control('model', 'model', 'kimi-k3', ['kimi-k3', 'deepseek-v4']),
  control('thought', 'thought', 'low', ['low', 'medium', 'high']),
]

const WITHOUT_LOW: readonly SessionConfigControl[] = [
  control('model', 'model', 'deepseek-v4', ['kimi-k3', 'deepseek-v4']),
  control('thought', 'thought', 'medium', ['medium', 'high']),
]

/* agent 换完模型先答复的那一张：模型换了，档位那一行还是上一个模型的。 */
const UNCONVERGED: readonly SessionConfigControl[] = [
  control('model', 'model', 'deepseek-v4', ['kimi-k3', 'deepseek-v4']),
  control('thought', 'thought', 'low', ['low', 'medium', 'high']),
]

const opened = (selectors: readonly SessionConfigControl[]): OpenedThread => ({
  thread: {
    threadId: THREAD,
    sessionId: SESSION,
    title: '',
    titleSource: 'fallback',
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
  selectors,
  goal: null,
  history: { state: 'fresh' },
})

const snapshot = (): ThreadSnapshot => ({
  thread: opened(WITH_LOW).thread,
  frames: { events: [], before: null },
})

/* 让已经兑现的那些 then 跑完。这里没有计时器，所以不需要假时钟。 */
async function settled(): Promise<void> {
  for (let tick = 0; tick < 8; tick += 1) {
    await Promise.resolve()
  }
}

const currentOf = (store: SessionControlsStore, id: string): string | undefined =>
  store.selectorsOf(THREAD)?.find((offered) => offered.id === id)?.current

describe('一条对话的那张表', () => {
  it('agent 先推收敛过的表、答复后到，屏幕留的是收敛过的那一张', async () => {
    let announce: ((report: SessionConfigReport) => void) | undefined
    let release: ((offered: readonly SessionConfigControl[]) => void) | undefined

    const config: SessionConfigPort = {
      select: () =>
        new Promise<readonly SessionConfigControl[]>((resolve) => {
          release = resolve
        }),
      subscribe: (handler) => {
        announce = handler

        return () => {
          announce = undefined
        }
      },
    }

    const store = new SessionControlsStore({ config, transcripts: routeSink() })
    const stop = store.start()

    store.opened(opened(WITH_LOW))

    expect(currentOf(store, 'thought')).toBe('low')

    store.selectControl(THREAD, 'model', 'deepseek-v4')
    await settled()

    /* agent 自己收敛了一次，推的是新模型真在用的那张表。 */
    announce?.({ sessionId: SESSION, controls: WITHOUT_LOW, goal: null })

    /* 这一趟答复是在那声推送之前发出的，它带的档位属于上一个模型。 */
    release?.(UNCONVERGED)
    await settled()

    expect(currentOf(store, 'model')).toBe('deepseek-v4')
    expect(currentOf(store, 'thought')).toBe('medium')

    stop()
  })

  it('agent 不补推时，答复仍然就是那张表', async () => {
    const config: SessionConfigPort = {
      select: () => Promise.resolve(WITHOUT_LOW),
      subscribe: () => () => undefined,
    }

    const store = new SessionControlsStore({ config, transcripts: routeSink() })
    const stop = store.start()

    store.opened(opened(WITH_LOW))
    store.selectControl(THREAD, 'thought', 'medium')
    await settled()

    expect(currentOf(store, 'thought')).toBe('medium')

    stop()
  })

  /* 通知是自己的：不再借道任何别的 store，所以裸构造就能验。 */
  it('自己的订阅：一份答复叫醒它，退订之后不再叫', () => {
    const store = new SessionControlsStore({})

    let woken = 0

    const stop = store.subscribe(() => {
      woken += 1
    })

    store.opened(opened(WITH_LOW))

    expect(woken).toBe(1)
    expect(currentOf(store, 'thought')).toBe('low')

    stop()
    store.forget(THREAD)

    expect(woken).toBe(1)
    expect(store.selectorsOf(THREAD)).toBeUndefined()
  })

  it('本地快照不等待 agent 激活即可落入转录', async () => {
    let finishActivation: ((answer: OpenedThread) => void) | undefined
    const adopted: string[] = []
    const baseSink = routeSink()
    const transcripts: TranscriptSink = {
      ...baseSink,
      adopt: (threadId) => adopted.push(threadId),
    }
    const port: ThreadPort = {
      list: () => Promise.resolve([]),
      read: () => Promise.resolve(snapshot()),
      create: () => Promise.resolve(opened(WITH_LOW)),
      open: () =>
        new Promise((resolve) => {
          finishActivation = resolve
        }),
      earlierFrames: () => Promise.resolve({ events: [], before: null }),
      outline: () => Promise.resolve([]),
      framesUntil: () => Promise.resolve({ events: [], before: null }),
    }
    const store = new SessionControlsStore({ port, transcripts })

    store.adopt(THREAD)
    await settled()

    expect(adopted).toEqual([THREAD])
    expect(store.selectorsOf(THREAD)).toBeUndefined()

    finishActivation?.(opened(WITH_LOW))
    await settled()

    expect(currentOf(store, 'model')).toBe('kimi-k3')
  })

  it('打开答复在实时推送之前恢复 agent 的目标真相', () => {
    const store = new SessionControlsStore({})
    const goal = {
      objective: '完成目标岛重构',
      completionCriterion: null,
      status: 'paused',
      turnsUsed: 4,
      tokensUsed: 3200,
      wallClockMs: 90_000,
      receivedAt: 42,
    } as const

    store.opened({ ...opened(WITH_LOW), goal })

    expect(store.goalOf(THREAD)).toBe(goal)
  })
})
