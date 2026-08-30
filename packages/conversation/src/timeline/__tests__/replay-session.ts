import type {
  AgentPromptHandle,
  AgentPromptRequest,
  AgentSessionPort,
  KapSessionId,
  RunEvent,
} from '../../agent'

/**
 * A session port that replays a recorded run.
 *
 * 测试替身：真契约、真时序，没有协议、没有子进程、没有凭据。事件与调度器都由调用
 * 方交进来 —— 它自己不认识任何一份录像，所以它住在测试面里，不在生产源码里。
 */

export type ReplayScheduler = (callback: () => void, delayMs: number) => () => void

export interface ReplaySessionOptions {
  readonly events: readonly RunEvent[]
  readonly stepMs?: number
  readonly scheduler?: ReplayScheduler
}

const defaultScheduler: ReplayScheduler = (callback, delayMs) => {
  const handle = setTimeout(callback, delayMs)
  return () => clearTimeout(handle)
}

/* 录像里只有一条会话：假的端口也按真的契约说话，而契约上的地址是会话号。 */
const SESSION: KapSessionId = 'sess_replay'

export function createReplaySession(options: ReplaySessionOptions): AgentSessionPort {
  const events = options.events
  const stepMs = options.stepMs ?? 40
  const scheduler = options.scheduler ?? defaultScheduler

  const listeners = new Set<(events: readonly RunEvent[], sessionId: KapSessionId) => void>()
  let pending: Array<() => void> = []

  const clearPending = () => {
    for (const cancel of pending) {
      cancel()
    }
    pending = []
  }

  /* 契约上交的是一批：录像一拍一帧，所以每批一帧 —— 真实端口攒到一帧时同形。 */
  const emit = (batch: readonly RunEvent[]) => {
    for (const listener of listeners) {
      listener(batch, SESSION)
    }
  }

  return {
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },

    prompt: (_request: AgentPromptRequest): Promise<AgentPromptHandle> => {
      clearPending()

      events.forEach((event, index) => {
        pending.push(scheduler(() => emit([event]), stepMs * index))
      })

      return Promise.resolve({ sessionId: SESSION, images: [] })
    },

    /* 录像里只有一条对话，所以停的就是它 —— 点名哪一条不改变要做的事。 */
    cancel: () => {
      clearPending()

      return Promise.resolve()
    },

    resolvePermission: () => Promise.resolve(),

    answerQuestions: () => Promise.resolve(),

    dismissQuestions: () => Promise.resolve(),

    steer: () => Promise.resolve(),

    abortPrompt: () => Promise.resolve(),
  }
}
