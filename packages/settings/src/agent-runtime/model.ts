import type { AgentProfile } from '@poietica/agent-catalog'
export interface AgentConfigSnapshot {
  readonly profile: AgentProfile
  readonly issues: readonly string[]
}
export interface AgentSettings {
  readonly load: () => Promise<AgentConfigSnapshot>
}
