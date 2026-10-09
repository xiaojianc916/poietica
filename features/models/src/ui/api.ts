import type { TypedRpcClient } from '@poietica/rpc'
import type { UiFeatureContext } from '@poietica/ui-kernel'
import type { CustomProviderDef, ModelInfo, ModelRef, ProviderInfo } from '../contract'
import { modelsContract } from '../contract'

/** ctx.rpc(modelsContract) 的薄封装 */
export function createModelsApi(ctx: UiFeatureContext) {
  const rpc: TypedRpcClient<typeof modelsContract> = ctx.rpc(modelsContract)
  return {
    providers: (): Promise<ProviderInfo[]> =>
      rpc.call('models.providers', {}).then((r: { providers: ProviderInfo[] }) => r.providers),
    setApiKey: (provider: string, apiKey: string): Promise<void> =>
      rpc.call('models.setApiKey', { provider, apiKey }).then(() => undefined),
    clearApiKey: (provider: string): Promise<void> =>
      rpc.call('models.clearApiKey', { provider }).then(() => undefined),
    upsertCustomProvider: (def: CustomProviderDef): Promise<void> =>
      rpc.call('models.upsertCustomProvider', def).then(() => undefined),
    removeCustomProvider: (providerId: string): Promise<void> =>
      rpc.call('models.removeCustomProvider', { providerId }).then(() => undefined),
    catalog: (): Promise<ModelInfo[]> => rpc.call('models.catalog', {}).then((r: { models: ModelInfo[] }) => r.models),
    setEnabled: (model: ModelRef, enabled: boolean): Promise<void> =>
      rpc.call('models.setEnabled', { model, enabled }).then(() => undefined),
    defaults: (): Promise<{ model: ModelRef | null; thinking: string | null }> => rpc.call('models.defaults', {}),
    setDefaults: (patch: { model?: ModelRef; thinking?: string | null }): Promise<void> =>
      rpc.call('models.setDefaults', patch).then(() => undefined),
    onChanged: (l: () => void) => rpc.on('models.changed', l),
  }
}

export type ModelsApi = ReturnType<typeof createModelsApi>
