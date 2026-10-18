import type { ConversationApi } from '../api'
import type { AgentSessionPort } from '../shared/model/session'
import { createSessionPort } from './session-port'

/*
 * 会话端口的注册表：**端口的身份只在这里管**。端口本身是无状态的转发层，有状态的是它的四个订阅与背后的那一条会话；
 * 既然「同一条对话永远握着同一个对象」是下游几条不变式的前提，身份就必须由一个地方统一发。
 * 不在组件里 `useMemo`：StrictMode 与「卸载再挂载」会把组件跑两遍，每一遍都新建一个对象 —— 端口身份跟着组件生命周期走就成了「有时同一根、有时不是」，
 * 下游那条判据会随机失效（多一份订阅、两份事实写同一格）。注册表住在功能装配层，生命周期是功能的生命周期。
 * 释放：对话被移除时调 `release(threadId)`；之后下次要它会现建一根。与 `TranscriptStore.forget` 各管一头：
 * 那一头退掉**订阅**，这一头丢掉**对象**；两个都从 threads.removed 同一个地方发起。
 */
export interface SessionRegistry {
  /** 这条对话的端口；已经有就交回同一个对象。 */
  port(threadId: string): AgentSessionPort
  /** 给「此刻能不能提交」这类判断用：它不该在问一句的时候顺手建出一根端口。 */
  peek(threadId: string): AgentSessionPort | undefined
  release(threadId: string): void
  releaseAll(): void
  /** 当前握着几条对话的端口。测试用它钉「订阅数没有泄漏」。 */
  size(): number
}

export interface SessionRegistryOptions {
  readonly api: ConversationApi
  readonly onSubmissions?:
    | ((threadId: string, rows: readonly import('../../contract').SubmissionView[]) => void)
    | undefined
}

export function createSessionRegistry({ api, onSubmissions }: SessionRegistryOptions): SessionRegistry {
  const held = new Map<string, AgentSessionPort>()

  return {
    port(threadId) {
      const existing = held.get(threadId)
      if (existing !== undefined) {
        return existing
      }
      const created = createSessionPort({
        api,
        threadId,
        ...(onSubmissions === undefined
          ? {}
          : {
              onSubmissions: (rows: readonly import('../../contract').SubmissionView[]) =>
                onSubmissions(threadId, rows),
            }),
      })
      held.set(threadId, created)
      return created
    },
    peek: (threadId) => held.get(threadId),
    release(threadId) {
      held.delete(threadId)
    },
    releaseAll() {
      held.clear()
    },
    size: () => held.size,
  }
}
