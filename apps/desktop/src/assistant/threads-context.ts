import {
  groupByWorkspace,
  type ThreadsStore,
  type ThreadWorkspaceList,
} from '@poietica/conversation'
import { createContext, useCallback, useContext, useMemo, useSyncExternalStore } from 'react'

/*
 * One conversation state, shared by the sidebar and the tab strip.
 *
 * Both show the same thing from different places, so they must read the
 * same state: two copies would let the list highlight one conversation
 * while the tabs believe another is open.
 *
 * Context 里放的是 store 本身，引用终生不变：谁重画由订阅决定，不由 Provider
 * 决定。放一个每次渲染新建的对象会让每个消费者连同整棵子树一起重画。
 *
 * 这个模块不导出组件，Provider 在 ThreadsProvider.tsx。那不是分层洁癖：
 * createContext() 在模块顶层执行，context 的身份就是这一次执行的产物，而
 * 一个同时导出组件与非组件的模块不满足 Fast Refresh 原地替换的条件，改动
 * 时只能被整模块重跑 —— 于是跑出一个新的 context，而尚未失效的消费者还握
 * 着旧的那个，界面当场抛下面那句话。拆开之后，改 Provider 走的是组件替换，
 * context 的身份不再随开发期的改动漂移。
 */

export const ThreadsContext = createContext<ThreadsStore | null>(null)

/*
 * 没有 Provider 就是接线错了，而不是退化成自带一份：两份状态会各自读一遍列表，
 * 并且能各自认为不同的对话正被打开——侧栏亮着一条、标签停在另一条就是这么来的。
 */
function useStore(): ThreadsStore {
  const shared = useContext(ThreadsContext)

  if (shared === null) {
    throw new Error('会话状态需要上层的 ThreadsProvider')
  }

  return shared
}

/** 只要动作，不订阅：拿到的回调引用终生不变，可以直接传给行组件。 */
export function useThreadsActions(): ThreadsStore {
  return useStore()
}

/*
 * 侧栏读的那一片：这三样之外的变化不会惊动它。
 *
 * 分组是 items 的纯函数，所以它钉在 items 的引用上 —— store 值没变就原样交回
 * 同一个数组，这一趟因此不重跑，侧栏拿到的组也还是同一批对象。分组规则住在
 * packages/agent/src/session/thread-order.ts，不在视图里：它是次序的一部分，与库那条
 * ORDER BY 同源。
 */
export function useThreadsList(): ThreadWorkspaceList {
  const store = useStore()

  const list = useSyncExternalStore(store.subscribe, store.listSnapshot, store.listSnapshot)

  const groups = useMemo(() => groupByWorkspace(list.items), [list.items])

  return { failure: list.failure, groups, isLoading: list.isLoading }
}

/*
 * 屏幕上这条对话开在哪个目录。
 *
 * 审查那一格据此问 git，不另存一份：目录是这条对话的事实（原生侧开对话时记
 * 下），不是某个面板的本地态。
 */
export function useConversationWorkspaceRoot(conversationId: string | null): string | null {
  const store = useStore()

  const read = useCallback(
    () => (conversationId === null ? null : store.rootOf(conversationId)),
    [conversationId, store],
  )

  return useSyncExternalStore(store.subscribe, read, read)
}
