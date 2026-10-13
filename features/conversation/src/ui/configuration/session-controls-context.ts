import { invariant } from '@poietica/foundation'
import { createContext, useCallback, useContext, useSyncExternalStore } from 'react'
import type { SessionConfigControl } from '../agent/config'
import type { SessionGoal } from '../agent/goal'
import type { SessionUsage } from '../agent/usage'
import type { SessionControlsStore } from './session-controls-store'

/*
 * Context 里放的是 store 本身，引用终生不变：谁重画由订阅决定，不由 Provider 决定 —— 放一个每次渲染新建的对象会让每个消费者连同整棵子树一起重画。
 * 与 agent-controls-context 成对：那一份是这一家 agent 的表（还没有对话时画它），这一份是某条会话自己的表。
 */

export const SessionControlsContext = createContext<SessionControlsStore | null>(null)

function useStore(): SessionControlsStore {
  const shared = useContext(SessionControlsContext)

  if (shared === null) {
    invariant(false, '这棵组件树上没有 SessionControlsContext，会话可调项无处可读。')
  }

  return shared
}

/* 状态面板可以挂在没有 Provider 的树上（弹层独立定位时）：读目标是装饰，读不到就不画目标那一区，不能因为缺 Provider 把整块面板拖崩。 */
function useOptionalStore(): SessionControlsStore | null {
  return useContext(SessionControlsContext)
}

/** 只要动作，不订阅：拿到的回调引用终生不变，可以直接传给子组件。 */
export function useSessionControlsActions(): SessionControlsStore {
  return useStore()
}

/*
 * #commit 每次提交都换一个快照对象，订阅整份就等于让「另一条对话认领到了选择器」这种与本格无关的事实重画整棵助手树。
 * 切片天然引用稳定：那两张表由 withEntry 维护，值没变就原样交回同一个 Map。
 */

/** 这条对话的选择器；还没拿到过是 undefined。 */
export function useThreadSelectors(threadId: string | null): readonly SessionConfigControl[] | undefined {
  const store = useStore()

  const read = useCallback(() => (threadId === null ? undefined : store.selectorsOf(threadId)), [store, threadId])

  return useSyncExternalStore(store.subscribe, read, read)
}

/** 这条对话上一次认领或改动失败时的说法。 */
export function useThreadSelectorFailure(threadId: string | null): string | undefined {
  const store = useStore()

  const read = useCallback(() => (threadId === null ? undefined : store.selectorFailureOf(threadId)), [store, threadId])

  return useSyncExternalStore(store.subscribe, read, read)
}

/** 这条对话背后那个会话最近报的上下文用量；还没报过是 undefined。 */
export function useThreadUsage(threadId: string | null): SessionUsage | undefined {
  const store = useStore()

  const read = useCallback(() => (threadId === null ? undefined : store.usageOf(threadId)), [store, threadId])

  return useSyncExternalStore(store.subscribe, read, read)
}

/** 这条对话此刻的目标；没有目标在跑是 undefined。 */
export function useThreadGoal(threadId: string | null): SessionGoal | undefined {
  const store = useStore()

  const read = useCallback(() => (threadId === null ? undefined : store.goalOf(threadId)), [store, threadId])

  return useSyncExternalStore(store.subscribe, read, read)
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
