/* 由 agent 报出；秒针从 wallClockMs 加 receivedAt 后的时间推，不另起累加器。 */
export interface SessionGoal {
  readonly objective: string
  readonly completionCriterion: string | null
  readonly status: SessionGoalStatus
  readonly turnsUsed: number
  readonly tokensUsed: number
  readonly wallClockMs: number
  /** 快照到达本机的单调时钟读数，用于把 wallClockMs 推到此刻。 */
  readonly receivedAt: number
}

export type SessionGoalStatus = 'active' | 'paused' | 'blocked' | 'complete'
