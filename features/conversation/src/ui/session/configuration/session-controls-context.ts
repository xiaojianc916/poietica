import { createContext, useCallback, useContext, useSyncExternalStore } from 'react'
import type { SessionGoal } from '../../shared/model/goal'
import type { SessionControlsStore } from './session-controls-store'

/*
 * Context 里放的是 store 本身，引用终生不变：谁重画由订阅决定，不由 Provider 决定 —— 放一个每次渲染新建的对象会让每个消费者连同整棵子树一起重画。
 * 与 agent-controls-context 成对：那一份是这一家 agent 的表（还没有对话时画它），这一份是某条会话自己的表。
 */

export const SessionControlsContext = createContext<SessionControlsStore | null>(null)

/* 状态面板可以挂在没有 Provider 的树上（弹层独立定位时）：读目标是装饰，读不到就不画目标那一区，不能因为缺 Provider 把整块面板拖崩。 */
function useOptionalStore(): SessionControlsStore | null {
  return useContext(SessionControlsContext)
}

/**
 * 没有 Provider 时返回 undefined（不画目标区），不抛 —— 状态面板必须能在 Provider 缺席的树上存活。
 */
export function useOptionalThreadGoal(threadId: string | null): {
  readonly goal: SessionGoal | undefined
  readonly controls: SessionControlsStore | null
} {
  const store = useOptionalStore()

  const read = useCallback(
    () => (store === null || threadId === null ? undefined : store.goalOf(threadId)),
    [store, threadId],
  )
  const subscribe = useCallback(
    (onChange: () => void) => (store === null ? () => undefined : store.subscribe(onChange)),
    [store],
  )
  const goal = useSyncExternalStore(subscribe, read, read)

  return { controls: store, goal }
}
