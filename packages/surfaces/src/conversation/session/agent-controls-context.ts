import type { AgentCapabilityStore, AgentControls, AgentToolkit } from '@poietica/conversation'
import { createContext, useCallback, useContext, useSyncExternalStore } from 'react'

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

/** 屏幕上那一格要的：表、失败的理由、名册的地址、改一项、再试一次。 */
export interface AgentControlsView extends AgentControls {
  /** 名册要按哪条会话读。入口那一格是 null。 */
  readonly adoptToolkit: (threadId: string | null) => void
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

  return {
    ...held,
    adoptToolkit: store.adoptToolkit,
    selectControl: store.selectControl,
    retry: store.refresh,
  }
}

/* 两个引用都固定：没有 store 就没有变化可订，也没有名册可给。 */
const NO_SUBSCRIPTION = () => () => {}
const NO_TOOLKIT: AgentToolkit = { skills: [], mcpServers: [] }

/**
 * 这一家 agent 公布的技能与 MCP 名册。
 *
 * 缺席即空名册 —— 组件工作台不套 Provider，而那两组只是不出现；可调项不同，
 * 它们是那些界面的必需品，所以 useAgentControls 缺席时抛错。
 */
export function useAgentToolkit(): AgentToolkit {
  const store = useContext(AgentControlsContext)
  const read = useCallback(() => store?.snapshot().toolkit ?? NO_TOOLKIT, [store])

  return useSyncExternalStore(store?.subscribe ?? NO_SUBSCRIPTION, read, read)
}
