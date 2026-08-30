import type { SessionConfigControl, SessionGoal, SessionUsage } from '@poietica/agent-contract'
import type { SessionControlsStore } from '@poietica/conversation'
import { createContext, useCallback, useContext, useSyncExternalStore } from 'react'

/*
 * 一条对话背后那个会话提供哪些可调项，读在这里。
 *
 * Context 里放的是 store 本身，引用终生不变：谁重画由订阅决定，不由 Provider 决定。
 * 放一个每次渲染新建的对象会让每个消费者连同整棵子树一起重画。
 *
 * 与 agent-controls-context 成对，而不是合成一个：那一份是这一家 agent 的表（还没有
 * 对话时画它），这一份是某条会话自己的表。ACP 把配置定义成会话级的，两张表分属两个
 * scope，读它们的也是两批人。
 */

export const SessionControlsContext = createContext<SessionControlsStore | null>(null)

function useStore(): SessionControlsStore {
  const shared = useContext(SessionControlsContext)

  if (shared === null) {
    throw new Error('这棵组件树上没有 SessionControlsContext，会话可调项无处可读。')
  }

  return shared
}

/** 只要动作，不订阅：拿到的回调引用终生不变，可以直接传给子组件。 */
export function useSessionControlsActions(): SessionControlsStore {
  return useStore()
}

/*
 * 一格只订自己要的那一片。
 *
 * #commit 每次提交都换一个快照对象，订阅整份就等于让「另一条对话认领到了选择器」
 * 这种与本格无关的事实重画整棵助手树 —— 转录、虚拟列表、输入框。
 *
 * 切片天然是引用稳定的：那两张表由 withEntry 维护，值没变就原样交回同一个 Map，
 * useSyncExternalStore 自己就会跳过。与转录那一侧的 useSlice 同一个形状。
 */

/** 这条对话的选择器；还没拿到过是 undefined。 */
export function useThreadSelectors(
  threadId: string | null,
): readonly SessionConfigControl[] | undefined {
  const store = useStore()

  const read = useCallback(
    () => (threadId === null ? undefined : store.selectorsOf(threadId)),
    [store, threadId],
  )

  return useSyncExternalStore(store.subscribe, read, read)
}

/** 这条对话上一次认领或改动失败时的说法。 */
export function useThreadSelectorFailure(threadId: string | null): string | undefined {
  const store = useStore()

  const read = useCallback(
    () => (threadId === null ? undefined : store.selectorFailureOf(threadId)),
    [store, threadId],
  )

  return useSyncExternalStore(store.subscribe, read, read)
}

/** 这条对话背后那个会话最近报的上下文用量；还没报过是 undefined。 */
export function useThreadUsage(threadId: string | null): SessionUsage | undefined {
  const store = useStore()

  const read = useCallback(
    () => (threadId === null ? undefined : store.usageOf(threadId)),
    [store, threadId],
  )

  return useSyncExternalStore(store.subscribe, read, read)
}

/** 这条对话此刻的目标；没有目标在跑是 undefined。 */
export function useThreadGoal(threadId: string | null): SessionGoal | undefined {
  const store = useStore()

  const read = useCallback(
    () => (threadId === null ? undefined : store.goalOf(threadId)),
    [store, threadId],
  )

  return useSyncExternalStore(store.subscribe, read, read)
}
