import { createContext, useContext } from 'react'

/**
 * 主代理以外的执行单元（子代理、后台作业）的控制出口。形状是 ConversationApi 的子集，组合根直接把 api 递进来；
 * 缺席（入口页、单测夹具）时各处把控件画成不可用，不是崩。
 */
export interface AgentControls {
  /** 取消一个运行中的子代理；它已结束 / 不认识时交回 false。 */
  cancelSubagent(threadId: string, agentId: string): Promise<boolean>
  /** 把一句话送进运行中的子代理（下一步之前读到）；它已结束时抛 engine.subagent_not_running。 */
  steerSubagent(threadId: string, agentId: string, text: string): Promise<void>
  /** 停一个后台作业；它已结束 / 不认识时交回 false。 */
  cancelBackgroundTask(threadId: string, taskId: string): Promise<boolean>
}

export const AgentControlsContext = createContext<AgentControls | null>(null)

export function useAgentControls(): AgentControls | null {
  return useContext(AgentControlsContext)
}
