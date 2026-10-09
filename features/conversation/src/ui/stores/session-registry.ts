import type { AgentSessionPort } from '../agent/session'
import type { ConversationApi } from '../api'
import { createSessionPort } from './session-port'

/*
 * 会话端口的注册表：**端口的身份只在这里管**。
 *
 * 一条对话一根端口（`session-port.ts` 的头注说明为什么端口是按对话建的），而端口
 * 本身是无状态的转发层 —— 真正有状态的是它的四个订阅与它背后的那一条会话。既然
 * 「同一条对话永远握着同一个对象」是下游几条不变式的前提（`TranscriptStore` 的
 * `#attach` 靠对象身份判「要不要重新订阅」），身份就必须由一个地方统一发。
 *
 * 为什么不在组件里 `useMemo`：React 会在 StrictMode 与「卸载再挂载」时把组件跑两遍，
 * 每一遍都会新建一个对象 —— 端口身份跟着组件生命周期走就成了「有时同一根、有时不是」，
 * 下游那条判据会随机失效（多一份订阅、两份事实写同一格）。注册表住在功能装配层
 * （`ui/index.tsx` 造一个，整个功能共享），生命周期是功能的生命周期。
 *
 * 释放：`release(threadId)` 在对话被移除时调用（`ui/index.tsx` 的 threads.removed）。
 * 释放之后下一次要它会现建一根 —— 「这条对话又回来了」在 Core 侧本来就是新会话。
 *
 * 与 `TranscriptStore.forget` 的关系：那一头退掉**订阅**（它是这台 store 的事实），
 * 这一头丢掉**对象**（它是身份的事实）。两个都从同一个地方发起（threads.removed），
 * 所以不会出现「一边忘了一边还记得」。
 */
export interface SessionRegistry {
  /** 这条对话的端口；已经有就交回同一个对象。 */
  port(threadId: string): AgentSessionPort
  /**
   * 已经有就交回，没有就交回 undefined。
   *
   * 给「此刻能不能提交」这类判断用：它不该在问一句的时候顺手建出一根端口。
   */
  peek(threadId: string): AgentSessionPort | undefined
  release(threadId: string): void
  releaseAll(): void
  /** 当前握着几条对话的端口。测试用它钉「订阅数没有泄漏」。 */
  size(): number
}

export interface SessionRegistryOptions {
  readonly api: ConversationApi
  /** 快照里的提交行交给谁（见 session-port 的 onSubmissions）。 */
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
