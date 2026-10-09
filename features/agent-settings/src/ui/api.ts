import type { TypedRpcClient } from '@poietica/rpc'
import type { UiFeatureContext } from '@poietica/ui-kernel'
import type { Capabilities, SettingDescriptor, SettingGroup } from '../contract'
import { agentSettingsContract } from '../contract'

/** ctx.rpc(agentSettingsContract) 的薄封装：把方法名收在一处，组件不认字符串 */
export function createAgentSettingsApi(ctx: UiFeatureContext) {
  const rpc: TypedRpcClient<typeof agentSettingsContract> = ctx.rpc(agentSettingsContract)
  return {
    catalog: (): Promise<{ groups: SettingGroup[] }> => rpc.call('agentSettings.catalog', {}),
    set: (path: string, value: unknown): Promise<SettingDescriptor> => rpc.call('agentSettings.set', { path, value }),
    reset: (path: string): Promise<SettingDescriptor> => rpc.call('agentSettings.reset', { path }),
    capabilities: (): Promise<Capabilities> => rpc.call('agentSettings.capabilities', {}),
    setCapability: (name: 'computerUse' | 'browserControl', enabled: boolean): Promise<Capabilities> =>
      rpc.call('agentSettings.setCapability', { name, enabled }),
    onChanged: (l: (p: { paths: string[] }) => void) => rpc.on('agentSettings.changed', l),
  }
}

export type AgentSettingsApi = ReturnType<typeof createAgentSettingsApi>
