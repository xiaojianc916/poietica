import type { AgentSessionEvent } from '@poietica/contract'
import { events } from '@poietica/contract'

export interface AgentEventSourceOptions {
  /**
   * 报告一次事件投递失败；监听本身是尽力而为的。
   *
   * stage 区分两件不同的事：'listen' 是订阅没装上，'decode' 是一条帧没过边界校验。
   * 合成一句话会把排障带偏（一条被拒的帧看起来像「监听没起来」）。
   */
  readonly onListenFailure?: (error: unknown, stage: 'listen' | 'decode') => void
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
  onListenFailure?: (error: unknown, stage: 'listen' | 'decode') => void,
): () => void {
  let cancelled = false
  let stop: (() => void) | null = listen((payload) => {
    if (cancelled) {
      return
    }
    try {
      handler(payload)
    } catch (cause) {
      /* 走到这里的是处理函数自己抛的：订阅本身是好的，坏的是这一条。 */
      onListenFailure?.(cause, 'decode')
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
  onListenFailure?: (error: unknown, stage: 'listen' | 'decode') => void,
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
