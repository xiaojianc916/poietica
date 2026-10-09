import { defineContract, defineMethod, defineNotification } from '@poietica/contract-kit'
import { z } from 'zod'
import { ApiKeyInput, CustomProviderDef, ModelInfo, ModelRef, ProviderInfo } from './entities'
import { modelsErrors } from './errors'

export * from './entities'
export { modelsErrors } from './errors'

const empty = z.object({})

export const modelsContract = defineContract({
  id: 'models',
  namespaces: ['models'],
  methods: [
    defineMethod({
      name: 'models.providers',
      owner: 'core',
      params: empty,
      result: z.object({ providers: z.array(ProviderInfo) }),
      description: '列出全部模型服务商及其是否已配置',
    }),
    defineMethod({
      name: 'models.setApiKey',
      owner: 'core',
      params: ApiKeyInput,
      result: empty,
      description: '写入服务商的 API key（只写不读）',
    }),
    defineMethod({
      name: 'models.clearApiKey',
      owner: 'core',
      params: z.object({ provider: z.string().min(1) }),
      result: empty,
      description: '清除服务商的 API key',
    }),
    defineMethod({
      name: 'models.upsertCustomProvider',
      owner: 'core',
      params: CustomProviderDef,
      result: empty,
      description: '新增或更新自定义服务商',
    }),
    defineMethod({
      name: 'models.removeCustomProvider',
      owner: 'core',
      params: z.object({ providerId: z.string().min(1) }),
      result: empty,
      description: '删除自定义服务商',
    }),
    defineMethod({
      name: 'models.catalog',
      owner: 'core',
      params: empty,
      result: z.object({ models: z.array(ModelInfo) }),
      description: '列出模型目录',
    }),
    defineMethod({
      name: 'models.setEnabled',
      owner: 'core',
      params: z.object({ model: ModelRef, enabled: z.boolean() }),
      result: empty,
      description: '启用或禁用模型',
    }),
    defineMethod({
      name: 'models.defaults',
      owner: 'core',
      params: empty,
      result: z.object({ model: ModelRef.nullable(), thinking: z.string().nullable() }),
      description: '默认模型与默认思考强度',
    }),
    defineMethod({
      name: 'models.setDefaults',
      owner: 'core',
      params: z.object({ model: ModelRef.optional(), thinking: z.string().nullable().optional() }),
      result: empty,
      description: '设置默认模型与默认思考强度',
    }),
  ],
  notifications: [
    defineNotification({
      name: 'models.changed',
      owner: 'core',
      params: empty,
      description: '模型目录、服务商或默认值变化',
    }),
  ],
  errors: modelsErrors,
})
