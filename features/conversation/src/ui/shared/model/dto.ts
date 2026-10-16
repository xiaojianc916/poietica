/* UI 读到的载荷形状；对不上引擎端口的字段如实留空，不编假值。 */

/** 此刻这份上下文的构成。缺席即这一份报数没带构成：屏幕退成只画总条。 */
export interface AgentUsageBreakdown {
  readonly systemPrompt: number
  readonly systemContext: number
  readonly systemTools: number
  readonly skills: number
  readonly messages: number
  readonly free: number
  readonly autoCompactBuffer: number
}

/**
 * used / size / breakdown 来自 Controls.context（omp 的 getContextUsage 加 computeContextBreakdown），明细是真的；
 * 三个 cache 累计引擎端口没报给 UI，如实留空。
 */
export interface AgentSessionUsage {
  readonly used: number
  readonly size: number
  readonly inputOther: number
  readonly inputCacheRead: number
  readonly inputCacheCreation: number
  readonly breakdown: AgentUsageBreakdown | null
}

export interface AgentPromptResult {
  readonly sessionId: string
  readonly promptId: string
  readonly submission?: import('../../../contract').SubmissionView
}

/** 一条线程在平台上的记录（对应 conversation 契约的 Thread） */
export interface AgentThread {
  readonly threadId: string
  readonly sessionId: string | null
  readonly title: string
  readonly titleSource: string
  readonly updatedAt: string
  readonly pinned: boolean
  readonly workspaceRoot: string | null
  readonly archived: boolean
}

export interface AgentHistory {
  readonly threads: readonly AgentThread[]
  readonly hasMore: boolean
}
