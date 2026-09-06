import type { AgentLaunch } from '@poietica/contract'

export interface AgentBridgeOptions {
  readonly launch: () => AgentLaunch | Promise<AgentLaunch>
  readonly cwd?: () => string | null
}
