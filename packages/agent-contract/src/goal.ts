/**
 * 目标模式此刻的事实，由 agent 报出。
 *
 * 唯一真相在 agent：这里不存"目标什么时候开始的"，只存它累计跑了多久。
 * 界面要显示秒针，就从 wallClockMs 加上这份快照到达之后的时间推，
 * 不另起一个累加器。
 */
export interface SessionGoal {
  readonly objective: string
  /** 达成判据，agent 给了才有。 */
  readonly completionCriterion: string | null
  readonly status: SessionGoalStatus
  readonly turnsUsed: number
  readonly tokensUsed: number
  /** agent 累计的运行时长。 */
  readonly wallClockMs: number
  /** 这份快照到达本机的时刻。本地事实，用于把 wallClockMs 推到此刻。 */
  readonly receivedAt: number
}

/** agent 报得出的四种，没有第五种。 */
export type SessionGoalStatus = 'active' | 'paused' | 'blocked' | 'complete'
