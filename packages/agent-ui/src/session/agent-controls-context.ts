import type { AgentCapabilityStore, AgentControls } from '@poietica/agent'
import { createContext, useContext, useSyncExternalStore } from 'react'

/*
 * 入口那一格的可调项由谁给。
 *
 * 能力属于 agent，某条会话此刻真在用什么才属于那条会话 —— 前者住在这台 store 里,
 * 后者住在 SessionControlsStore 里，两个 scope 各有一台。ChatGPT / Claude / Cursor /
 * VS Code Copilot Chat 的新会话界面都画得出模型与模式选择器，而那一刻既没有对话也
 * 没有会话，所以入口那一格的表不可能按 threadId 寻址。
 *
 * 实例由组合根造出来，经 Context 交给下面所有人，useSyncExternalStore 订的是拿到手
 * 的那一个，不是 import 来的那一个 —— 与同目录的 transcripts-context 一个形制。
 * React 19 起 <Context value> 是官方形制，不再走内层 Provider 属性。
 *
 * 没有默认实例：拿不到就是接线漏了，那要当场说出来，而不是让半棵组件树对着一份
 * 永远不会更新的空表。
 */
export const AgentControlsContext = createContext<AgentCapabilityStore | null>(null)

/** 屏幕上那一格要的四样：表、失败的理由、改一项、再试一次。 */
export interface AgentControlsView extends AgentControls {
  readonly selectControl: (controlId: string, value: string) => void
  readonly retry: () => void
}

export function useAgentControls(): AgentControlsView {
  const store = useContext(AgentControlsContext)

  if (store === null) {
    throw new Error('这棵组件树上没有 AgentControlsContext，可调项无处可读。')
  }

  /*
   * 两个动作是 store 上的绑定方法，引用终生不变，所以消费者可以把它们直接放进
   * 依赖数组 —— 那正是下游那些 useCallback 能真的钉住标识的前提。
   */
  const held = useSyncExternalStore(store.subscribe, store.snapshot)

  return { ...held, selectControl: store.selectControl, retry: store.refresh }
}
