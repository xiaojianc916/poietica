import type { ModelRef, Posture } from '@poietica/engine'
import type { Thread } from '../../contract'
import type { PreparedThread } from '../timeline'
import type { SessionRegistry } from './session-registry'

/*
 * `prepare()` 的防重入与幂等住在这里，不在组件里：号是**发出第一句话时**才铸的，而「按了两次发送」「React 把组件跑了两遍」都会让同一次铸号被请求两回 ——
 * 中了就是两条空线程争夺同一句正文。写成这台无 DOM 的小状态机，判据就能直接单测。
 * 它与端口注册表各管一半：这台管「号只铸一次」，那台管「同一条对话只有一根端口」。
 */

/** 入口页那排选择器的本地草稿：铸号时带进 `threads.create`（CV-14）。 */
export interface ThreadEntryInit {
  readonly workspaceId: string
  readonly model?: ModelRef
  readonly thinking?: string
  readonly posture?: Posture
}

/**
 * `init` 由调用方**在调用的这一刻**算好（工作区、草稿），所以这台状态机不持有任何会过期的输入。`null` 表示这一刻开不出对话：不是失败，是「还不行」。
 */
export interface PrepareRequest {
  readonly init: ThreadEntryInit | null
  readonly create: (init: ThreadEntryInit) => Promise<Thread>
  readonly created: (thread: Thread) => void
  readonly sessions: SessionRegistry
}

export interface ThreadEntry {
  /** 已经铸过：原样交回手上那一份，**不再建第二条线程**；正在铸：交回进行中的那一趟，**不并发第二趟**。 */
  prepare(request: PrepareRequest): Promise<PreparedThread | null>
  /** 已经铸好的那一份；没有就是 null（不触发铸号）。 */
  peek(): PreparedThread | null
  /** 这一格离开入口相位（导航到线程页、或整页重来）：下一次 prepare 重新铸号。 */
  clear(): void
}

export function createThreadEntry(): ThreadEntry {
  let prepared: PreparedThread | null = null
  let inflight: Promise<PreparedThread | null> | null = null

  return {
    peek: () => prepared,
    clear: () => {
      prepared = null
      inflight = null
    },
    prepare(request) {
      if (prepared !== null) {
        return Promise.resolve(prepared)
      }
      if (inflight !== null) {
        return inflight
      }
      const { init } = request
      if (init === null) {
        return Promise.resolve(null)
      }
      const attempt = request
        .create(init)
        .then((thread) => {
          request.created(thread)
          const next: PreparedThread = { key: thread.id, port: request.sessions.port(thread.id) }
          prepared = next
          return next
        })
        .finally(() => {
          if (inflight === attempt) {
            inflight = null
          }
        })
      inflight = attempt
      return attempt
    },
  }
}
