import type { AgentConfigRecord } from '@poietica/contract/settings'
export interface AgentConfigurationRepository {
  readonly load: () => Promise<AgentConfigRecord>
  readonly saveAgents: (
    agents: readonly unknown[],
    defaultAgentId: string,
  ) => Promise<AgentConfigRecord>
}
