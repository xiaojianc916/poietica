import type { ModelsPort } from '@poietica/engine'
import { AppError, type Logger } from '@poietica/foundation'
import type { CustomProviderDef, ModelInfo, ModelRef, ProviderInfo } from '../contract'
import { modelsErrors } from '../contract/errors'

export interface ModelsServiceDeps {
  readonly models: ModelsPort
  readonly logger: Logger
  readonly emitChanged: () => void
}

export interface ModelsService {
  providers(): Promise<ProviderInfo[]>
  setApiKey(provider: string, apiKey: string): Promise<void>
  clearApiKey(provider: string): Promise<void>
  upsertCustomProvider(def: CustomProviderDef): Promise<void>
  removeCustomProvider(providerId: string): Promise<void>
  catalog(): Promise<ModelInfo[]>
  setEnabled(model: ModelRef, enabled: boolean): Promise<void>
  defaults(): Promise<{ model: ModelRef | null; thinking: string | null }>
  setDefaults(input: { model?: ModelRef; thinking?: string | null }): Promise<void>
}

/** 内置服务商 = engine.models.providers() 里 custom === false 的项（07 页 §6C：不硬编码名单） */
async function builtinIds(models: ModelsPort): Promise<ReadonlySet<string>> {
  const providers = await models.providers()
  return new Set(providers.filter((p) => !p.custom).map((p) => p.id))
}

export function createModelsService(d: ModelsServiceDeps): ModelsService {
  return {
    // 每个方法都是对 ctx.engine.models 的一次调用加参数校验，没有自己的表（07 页 §6C）
    providers: () => d.models.providers(),

    async setApiKey(provider, apiKey) {
      const providers = await d.models.providers()
      if (!providers.some((p) => p.id === provider)) {
        throw new AppError(modelsErrors.provider_not_found, '模型服务商不存在')
      }
      await d.models.setApiKey(provider, apiKey)
      // 日志里只记服务商名：绝不把 params 整体写进日志（07 页 §6.4 坑 1）
      d.logger.info('api key set', { provider })
      d.emitChanged()
    },

    async clearApiKey(provider) {
      const providers = await d.models.providers()
      if (!providers.some((p) => p.id === provider)) {
        throw new AppError(modelsErrors.provider_not_found, '模型服务商不存在')
      }
      await d.models.clearApiKey(provider)
      d.logger.info('api key cleared', { provider })
      d.emitChanged()
    },

    async upsertCustomProvider(def) {
      if ((await builtinIds(d.models)).has(def.id)) {
        throw new AppError(modelsErrors.builtin_provider_readonly, '内置服务商不能删除或修改')
      }
      await d.models.upsertCustomProvider(def)
      d.logger.info('custom provider saved', { provider: def.id })
      d.emitChanged()
    },

    async removeCustomProvider(providerId) {
      if ((await builtinIds(d.models)).has(providerId)) {
        throw new AppError(modelsErrors.builtin_provider_readonly, '内置服务商不能删除或修改')
      }
      await d.models.removeCustomProvider(providerId)
      d.logger.info('custom provider removed', { provider: providerId })
      d.emitChanged()
    },

    catalog: () => d.models.models(),

    async setEnabled(model, enabled) {
      await d.models.setModelEnabled(model, enabled)
      d.emitChanged()
    },

    async defaults() {
      return { model: await d.models.defaultModel(), thinking: await d.models.defaultThinking() }
    },

    async setDefaults(input) {
      if (input.model !== undefined) await d.models.setDefaultModel(input.model)
      if (input.thinking !== undefined) await d.models.setDefaultThinking(input.thinking)
      d.emitChanged()
    },
  }
}
