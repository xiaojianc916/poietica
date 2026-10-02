import type { AgentProfile } from '@poietica/agent-catalog'
import type { StoredAgentProfile } from './model'
export interface AgentConfigurationRepository {
  readonly load: () => Promise<StoredAgentProfile>
  readonly save: (profile: AgentProfile) => Promise<StoredAgentProfile>
}
