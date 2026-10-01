import type { AgentSessionEvent } from '@poietica/contract'
import { events } from '@poietica/contract'

export interface AgentEventSourceOptions {
  /** 报告一次事件投递失败；监听本身是尽力而为的。 */
  readonly onListenFailure?: (error: unknown) => void
}

/**
 * 订阅一个生成事件。
 *
 * preload 的 on 是同步的、直接返回卸载函数，所以没有在途注册要收尾：失败只可能来自
 * 处理函数本身，报出去就行，后面的帧照常送。
 *
 * 卸载幂等：调用方是 React 的 effect，清理跑两次不该把宿主那侧的监听摘两遍。
 */
export function subscribeToEvent<TPayload>(
  listen: (handler: (payload: TPayload) => void) => () => void,
  handler: (payload: TPayload) => void,
  onListenFailure?: (error: unknown) => void,
): () => void {
  let cancelled = false
  let stop: (() => void) | null = listen((payload) => {
    if (cancelled) {
      return
    }
    try {
      handler(payload)
    } catch (cause) {
      onListenFailure?.(cause)
    }
  })

  return () => {
    cancelled = true
    stop?.()
    stop = null
  }
}

export function subscribeToSessionEvent<TKind extends AgentSessionEvent['kind']>(
  kind: TKind,
  handler: (payload: Extract<AgentSessionEvent, { kind: TKind }>) => void,
  onListenFailure?: (error: unknown) => void,
): () => void {
  return subscribeToEvent<AgentSessionEvent>(
    (receive) => events.agentSessionEvent(receive),
    (payload) => {
      if (payload.kind === kind) {
        handler(payload as Extract<AgentSessionEvent, { kind: TKind }>)
      }
    },
    onListenFailure,
  )
}
