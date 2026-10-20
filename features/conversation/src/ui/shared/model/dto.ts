/* UI 读到的载荷形状；对不上引擎端口的字段如实留空，不编假值。 */

/** 此刻这份上下文的构成。缺席即这一份报数没带构成：屏幕退成只画总条。 */
export interface AgentUsageBreakdown {
  readonly systemPrompt: number
  readonly systemContext: number
  readonly systemTools: number
  readonly skills: number
  readonly messages: number
}

/** 本会话至今的 token 用量（omp 的 sessionManager.getUsageStatistics()，原样转运）。 */
export interface AgentSessionTokens {
  /** 未命中缓存的输入 */
  readonly input: number
  readonly output: number
  readonly cacheRead: number
  readonly cacheWrite: number
  /** input + output + cacheRead + cacheWrite（omp 的 totalTokens） */
  readonly total: number
}

/**
 * used / size / breakdown 来自 Controls.context（omp 的 getContextUsage 加 computeContextBreakdown），
 * tokens 来自同一份报数里 omp 的会话用量累计；三者都是 omp 的原数，屏幕只做派生（比例、短写）。
 */
export interface AgentSessionUsage {
  readonly used: number
  readonly size: number
  readonly breakdown: AgentUsageBreakdown | null
  /** 读不到（替身、老会话）时为 null：面板不画「缓存命中率 / token 消耗」两行 */
  readonly tokens: AgentSessionTokens | null
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
