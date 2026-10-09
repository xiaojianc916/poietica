import type { ProviderInfo } from '../contract'
import type { ModelsApi } from './api'
import type {
  CatalogProviderDto,
  ModelCatalogData,
  ModelCatalogOperation,
  ModelCatalogPort,
  ModelDto,
  ProviderDto,
} from './model-catalog'

/*
 * ModelCatalogPort 在 models 契约上的实现：**新架构里唯一换掉的那一层**。
 *
 * legacy 的那一份由原生侧的 catalog 命令实现（含 agent-CLI 安装、六种 provider 类型、
 * 联网目录）。新架构里数据来自引擎端口的两张表（07 页 §6C：Core 的九个方法就是对
 * \`ctx.engine.models\` 的一次转发），所以这里把两张表折成组件在用的读法：
 *
 *   providers ← 已配置/自定义的服务商（内置的配好 key 也算）
 *   models    ← 属于上面那些服务商的模型
 *   catalog   ← 还没配的内置服务商（「从目录添加」那一页列它，选中后只需填 key）
 */
function toProvider(provider: ProviderInfo): ProviderDto {
  return {
    id: provider.id,
    providerType: provider.custom ? 'custom' : 'builtin',
    baseUrl: null,
    defaultModel: null,
    hasApiKey: provider.configured,
    status: provider.configured ? 'configured' : 'unconfigured',
    models: null,
  }
}

export function createCatalogPort(api: ModelsApi): ModelCatalogPort {
  const read = async (): Promise<ModelCatalogData> => {
    const [providers, models, defaults] = await Promise.all([api.providers(), api.catalog(), api.defaults()])
    const configured = providers.filter((provider) => provider.custom || provider.configured)
    const ids = new Set(configured.map((provider) => provider.id))

    const wireModels: ModelDto[] = models
      .filter((model) => ids.has(model.provider))
      .map((model) => ({
        provider: model.provider,
        model: model.id,
        displayName: model.name,
        maxContextSize: model.contextWindow ?? 0,
        capabilities: null,
        maxOutputSize: null,
        supportEfforts: null,
        adaptiveThinking: model.reasoning,
        defaultEffort: null,
      }))

    const catalog: CatalogProviderDto[] = providers
      .filter((provider) => !provider.custom && !provider.configured)
      .map((provider) => ({
        id: provider.id,
        name: provider.name,
        wireType: null,
        guessed: false,
        needsBaseUrl: false,
        rejected: false,
        rejectReason: null,
        envKey: null,
        models: models
          .filter((model) => model.provider === provider.id)
          .map((model) => ({
            id: model.id,
            name: model.name,
            maxContextSize: model.contextWindow ?? 0,
            capabilities: null,
            reasoning: model.reasoning,
          })),
      }))

    return {
      providers: configured.map(toProvider),
      models: wireModels,
      catalog,
      defaultModel: defaults.model === null ? null : `${defaults.model.provider}/${defaults.model.id}`,
    }
  }

  const execute = async (operation: ModelCatalogOperation): Promise<ModelCatalogData> => {
    switch (operation.kind) {
      case 'snapshot':
      case 'refreshProviders':
        break
      case 'delete': {
        const target = operation.providerId
        const isCustom = (await api.providers()).some((p) => p.id === target && p.custom)
        if (isCustom) await api.removeCustomProvider(target)
        else await api.clearApiKey(target)
        break
      }
      case 'create':
      case 'replace': {
        const source = operation.kind === 'create' ? operation.provider : operation.provider
        const id =
          operation.kind === 'create' ? operation.provider.id : (operation.provider.newId ?? operation.providerId)
        await api.upsertCustomProvider({
          id,
          name: id,
          api:
            source.providerType === 'anthropic'
              ? 'anthropic-messages'
              : source.providerType === 'openai_responses'
                ? 'openai-responses'
                : 'openai-completions',
          baseUrl: source.baseUrl ?? '',
          models: source.models.map((model) => ({
            id: model.model,
            name: model.displayName ?? model.model,
            contextWindow: model.maxContextSize,
            reasoning: model.adaptiveThinking === true,
            vision: (model.capabilities ?? []).includes('vision'),
          })),
        })
        if (operation.kind === 'replace' && operation.providerId !== id) {
          await api.removeCustomProvider(operation.providerId)
        }
        if (source.apiKey !== undefined && source.apiKey !== '') await api.setApiKey(id, source.apiKey)
        break
      }
      case 'importCatalog': {
        // 目录导入 = 给这家服务商填 key（内置服务商在 omp 里只需要这一个）
        if (operation.apiKey !== undefined && operation.apiKey !== '') {
          await api.setApiKey(operation.catalogId, operation.apiKey)
        }
        break
      }
      case 'setDefault': {
        const at = operation.modelId.indexOf('/')
        if (at > 0) {
          await api.setDefaults({
            model: { provider: operation.modelId.slice(0, at), id: operation.modelId.slice(at + 1) },
          })
        }
        break
      }
    }
    return read()
  }

  return {
    execute,
    // 目录变了要重取：契约的 models.changed 通知（04 页 §2.2）
    subscribeInvalidation: async (listener) => {
      const subscription = api.onChanged(listener)
      return () => {
        subscription.dispose()
      }
    },
  }
}
