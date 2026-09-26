import type { AgentSessionUsage } from '@poietica/contract/conversation'

/* 数由 agent 自己算（session.getSessionStats）；推送 volatile：到达即替换，断线不回放。 */
export type SessionUsage = Readonly<AgentSessionUsage>

export interface SessionUsageReport {
  readonly sessionId: string
  readonly usage: SessionUsage
}

export interface SessionUsagePort {
  readonly subscribe: (handler: (report: SessionUsageReport) => void) => () => void
}
