import type { AgentSessionUsage } from './dto'

/* 数由 agent 自己算（session.getSessionStats）；推送 volatile —— 到达即替换，断线不回放。 */
export type SessionUsage = Readonly<AgentSessionUsage>

export interface SessionUsageReport {
  readonly sessionId: string
  readonly usage: SessionUsage
}

export interface SessionUsagePort {
  readonly subscribe: (handler: (report: SessionUsageReport) => void) => () => void
}

/** token 数的短写（39.9K、151K、1.5M）：上下文用量那一格、时间线的压缩行共用这一条规则 */
export function formatTokens(value: number): string {
  const scaled = (candidate: number) =>
    candidate >= 100 ? String(Math.round(candidate)) : String(Math.round(candidate * 10) / 10)

  if (value < 1_000) {
    return String(value)
  }
  if (value < 1_000_000) {
    return `${scaled(value / 1_000)}K`
  }
  return `${scaled(value / 1_000_000)}M`
}
