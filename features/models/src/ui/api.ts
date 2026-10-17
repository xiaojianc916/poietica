import type { TypedRpcClient } from '@poietica/rpc'
import type { UiFeatureContext } from '@poietica/ui-kernel'
import type {
  CustomProviderDef,
  LoginEvent,
  LoginProvider,
  ModelInfo,
  ModelRef,
  ModelRoleInfo,
  ProviderInfo,
} from '../contract'
import { modelsContract } from '../contract'

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
    roles: (): Promise<ModelRoleInfo[]> =>
      rpc.call('models.roles', {}).then((r: { roles: ModelRoleInfo[] }) => r.roles),
    setRole: (role: string, selector: string | null): Promise<void> =>
      rpc.call('models.setRole', { role, selector }).then(() => undefined),
    onChanged: (l: () => void) => rpc.on('models.changed', l),
    /* 订阅登录：流程在 Core 那台机器上的 omp 里跑，这里只开头、答格、取消、听事件 */
    loginProviders: (): Promise<LoginProvider[]> => rpc.call('models.loginProviders', {}).then((r) => r.providers),
    startLogin: (providerId: string): Promise<string> =>
      rpc.call('models.startLogin', { providerId }).then((r) => r.loginId),
    answerLogin: (loginId: string, promptId: string, value: string): Promise<void> =>
      rpc.call('models.answerLogin', { loginId, promptId, value }).then(() => undefined),
    cancelLogin: (loginId: string): Promise<void> => rpc.call('models.cancelLogin', { loginId }).then(() => undefined),
    onLoginEvent: (l: (p: { loginId: string; event: LoginEvent }) => void) => rpc.on('models.loginEvent', l),
  }
}

export type ModelsApi = ReturnType<typeof createModelsApi>
