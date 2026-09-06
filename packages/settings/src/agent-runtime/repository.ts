import type { AgentConfigRecord, AgentInstallStatus } from '@poietica/contract/settings'
export interface AgentConfigurationRepository {
  readonly load: () => Promise<AgentConfigRecord>
  readonly saveAgents: (
    agents: readonly unknown[],
    defaultAgentId: string,
  ) => Promise<AgentConfigRecord>
  readonly loadInstallStatus: (agentId: string, force: boolean) => Promise<AgentInstallStatus>
  readonly runInstall: (agentId: string) => Promise<AgentInstallStatus>
}
