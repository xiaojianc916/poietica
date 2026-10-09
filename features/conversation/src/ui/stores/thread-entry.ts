import type { ModelRef, Posture } from '@poietica/engine'
import type { Thread } from '../../contract'
import type { PreparedThread } from '../transcript/transcript-store'
import type { SessionRegistry } from './session-registry'

/*
 * 入口那一格的铸号机：`prepare()` 的防重入与幂等住在这里，不在组件里。
 *
 * 为什么单独一台：入口页那一格的号是**发出第一句话时**才铸的（`threads.create` 由
 * Core 铸号，05 页 §11.4），而「按了两次发送」「React 把组件跑了两遍」这两件事都会
 * 让同一次铸号被请求两回 —— 中了就是两条空线程争夺同一句正文。判据要用 ref/state
 * 写进组件的话，只有渲染测试量得到；写成这台无 DOM 的小状态机，判据就能直接单测。
 *
 * 它与端口注册表（`session-registry.ts`）各管一半：这台管「号只铸一次」，那台管
 * 「同一条对话只有一根端口」。两半都由装配层持有，组件只交入参、取结果。
 */

/** 入口页那排选择器的本地草稿：铸号时带进 `threads.create`（方案 §07、CV-14）。 */
export interface ThreadEntryInit {
  readonly workspaceId: string
  readonly model?: ModelRef
  readonly thinking?: string
  readonly posture?: Posture
}

/**
 * 这一次铸号请求的全副入参。
 *
 * `init` 由调用方**在调用的这一刻**算好（工作区、草稿），所以这台状态机不持有任何
 * 会过期的输入 —— 组件重渲染换了工作区，下一次请求自然带新的那一份。
 *
 * `null` 表示这一刻开不出对话（例如还没选工作区）：不是失败，是「还不行」。
 */
export interface PrepareRequest {
  readonly init: ThreadEntryInit | null
  readonly create: (init: ThreadEntryInit) => Promise<Thread>
  readonly created: (thread: Thread) => void
  readonly sessions: SessionRegistry
}

export interface ThreadEntry {
  /**
   * 铸号，交回这一条提交要落的键与它的端口。
   *
   * - 已经铸过：原样交回手上那一份，**不再建第二条线程**；
   * - 正在铸：交回进行中的那一趟，**不并发第二趟**；
   * - 还没铸：`threads.create` → 记进线程列表 → 按号取端口。
   */
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
