import type { AgentProfile } from '@poietica/agent-catalog'
import type { AgentInstallStatus as WireInstallStatus } from '@poietica/contract/settings'
export type AgentInstallStatus = Readonly<WireInstallStatus>
export type AgentInstallState = AgentInstallStatus['state']
export interface AgentConfigSnapshot {
  readonly profile: AgentProfile
  readonly issues: readonly string[]
}
export interface AgentSettings {
  readonly load: () => Promise<AgentConfigSnapshot>
  readonly loadInstallStatus: (
    agentId: string,
    options?: { readonly force?: boolean },
  ) => Promise<AgentInstallStatus>
  readonly runInstall: (agentId: string) => Promise<AgentInstallStatus>
  readonly notifyConfigChanged: () => void
  readonly subscribeConfigChanged: (listener: () => void) => () => void
}
