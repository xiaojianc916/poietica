import type { AgentProfile } from '@poietica/agent-catalog'
export interface AgentConfigSnapshot {
  readonly profile: AgentProfile
  readonly issues: readonly string[]
}
/** 线上那一份：declared 成 unknown 是因为校验归 @poietica/agent-catalog 的判读；磁盘上还没有档案时是 null。 */
export interface StoredAgentProfile {
  readonly profile: unknown
  readonly issues: readonly string[]
}
export interface AgentSettings {
  readonly load: () => Promise<AgentConfigSnapshot>
}
