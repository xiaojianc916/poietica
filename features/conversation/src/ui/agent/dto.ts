/*
 * UI 读到的**载荷形状**（逐条照 legacy \`@poietica/contract/conversation\` 的字段抄）。
 *
 * 迁移说明：那一份是全应用的线上契约汇总，新架构把它拆成「引擎端口的值对象（@poietica/engine）
 * + 每个功能自己的 contract」。UI 组件读的是**载荷形状**，所以这里保留形状、来源换成新架构：
 * 下面每个类型都写明了它在 P5 的对应物；对不上的字段（例如 legacy 由原生侧算的用量构成明细）
 * 如实留空，不编一个假值。
 */

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
 * 会话用量。
 *
 * used / size / breakdown 来自 Controls.context：新引擎把 omp 自己的 getContextUsage 与
 * computeContextBreakdown（/context 面板那一份）一起报上来，构成明细因此是**真的**，
 * 面板那七行画得出来。
 *
 * inputOther / inputCacheRead / inputCacheCreation 来自 UsageSample 的 input / cacheRead /
 * cacheWrite 的累计，是**账**上的数；引擎端口目前没有把这三个累计值报给 UI，如实留空。
 */
export interface AgentSessionUsage {
  readonly used: number
  readonly size: number
  readonly inputOther: number
  readonly inputCacheRead: number
  readonly inputCacheCreation: number
  readonly breakdown: AgentUsageBreakdown | null
}

/** 一次提示投递的结果（「Core 即时回显」：`submission` 是 Core 存下的那条记录）。 */
export interface AgentPromptResult {
  readonly sessionId: string
  readonly promptId: string
  readonly submission?: import('../../contract').SubmissionView
}

/** 一条线程在平台上的记录（P5 对应 conversation 契约的 Thread） */
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

/** 线程历史的一页 */
export interface AgentHistory {
  readonly threads: readonly AgentThread[]
  readonly hasMore: boolean
}
