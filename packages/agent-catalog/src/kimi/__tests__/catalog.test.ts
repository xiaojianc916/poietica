import { describe, expect, it } from 'bun:test'
import { builtinAgentProviderById, builtinAgentProviders } from '../../provider-presets'
import type { AgentProviderState } from '../../provider-state'
import { kimiCatalogCodec } from '../catalog'

/*
 * 这一家的目录文档必须具备的形状。
 *
 * 判据不是 models.dev 长什么样，而是对方的解析器逐字读什么（@moonshot-ai/kosong 的
 * src/catalog.ts）：type 在场就以它为准；api 是接口地址；models 表每条都要有 id 与一个
 * 正整数的 limit.context —— 缺了，catalogModelToCapability 会把那条模型整条丢掉，于是
 * --default-model 校验不过、界面上下拉是空的。
 *
 * 这些用例此前分散在通用 __tests__ 下的 builtin-catalog.test.ts 与
 * import-document.test.ts 两个文件里，被测对象却都是这一家。合并到这一家自己的
 * __tests__ 下：两份文档形状共用同一条判据，本来就该看得见彼此。
 */

const provider: AgentProviderState = {
  id: 'moonshot-cn',
  type: 'kimi',
  baseUrl: 'https://api.moonshot.cn/v1',
  configured: true,
  credentialKind: 'apiKey',
  registryUrl: undefined,
  synthetic: false,
  models: [
    {
      alias: 'moonshot-cn/kimi-k3',
      displayName: 'kimi-k3',
      providerId: 'moonshot-cn',
      maxContextSize: 1048576,
      capabilities: ['thinking', 'always_thinking', 'image_in', 'video_in', 'tool_use'],
      supportEfforts: ['low', 'high', 'max'],
    },
    {
      alias: 'moonshot-cn/kimi-k2.6',
      displayName: 'kimi-k2.6',
      providerId: 'moonshot-cn',
      maxContextSize: 262144,
      capabilities: ['thinking', 'image_in', 'video_in', 'tool_use'],
      supportEfforts: [],
    },
    {
      alias: 'moonshot-cn/kimi-k2.5',
      displayName: 'moonshot-cn/kimi-k2.5',
      providerId: 'moonshot-cn',
      maxContextSize: 262144,
      capabilities: ['thinking', 'tool_use'],
      supportEfforts: [],
    },
    {
      alias: 'moonshot-cn/bare',
      displayName: 'bare',
      providerId: 'moonshot-cn',
      maxContextSize: undefined,
      capabilities: [],
      supportEfforts: [],
    },
  ],
}

function entryOf(document: string, providerId: string): Record<string, unknown> {
  const catalog = JSON.parse(document) as Record<string, Record<string, unknown>>
  const entry = catalog[providerId]

  if (entry === undefined) {
    throw new Error(`目录文档缺 ${providerId}`)
  }

  return entry
}

describe('kimiCatalogCodec.catalogDocument', () => {
  it('顶层是 id → 厂商的表，条目带 type / api / models', () => {
    const preset = builtinAgentProviders()[0]

    if (preset === undefined) {
      throw new Error('内置厂商表为空')
    }

    const entry = entryOf(kimiCatalogCodec.catalogDocument([preset]), preset.id)

    expect(entry['type']).toBe(preset.wire)
    expect(entry['api']).toBe(preset.baseUrl)

    const models = entry['models'] as Record<string, Record<string, unknown>>
    expect(Object.keys(models)).toEqual(preset.models.map((model) => model.id))
  })

  it('每条模型都带 id 与正整数 limit.context，缺了对方会整条丢掉', () => {
    const document = kimiCatalogCodec.catalogDocument(builtinAgentProviders())
    const catalog = JSON.parse(document) as Record<
      string,
      { models?: Record<string, { id?: unknown; limit?: { context?: unknown } }> }
    >

    for (const [providerId, entry] of Object.entries(catalog)) {
      for (const [modelId, model] of Object.entries(entry.models ?? {})) {
        const label = `${providerId}/${modelId}`

        expect(model.id, label).toBe(modelId)
        expect(typeof model.limit?.context, label).toBe('number')
      }
    }
  })

  it('文档里一个密钥字段都没有', () => {
    const document = kimiCatalogCodec.catalogDocument(builtinAgentProviders())

    expect(document).not.toContain('apiKey')
    expect(document).not.toContain('api_key')
  })

  it('声明了思考的模型带 reasoning 与 reasoning_options，档位原样进 values', () => {
    const deepseek = builtinAgentProviderById('deepseek')

    if (deepseek === undefined) {
      throw new Error('内置表缺 deepseek')
    }

    const entry = entryOf(kimiCatalogCodec.catalogDocument([deepseek]), 'deepseek')
    const models = entry['models'] as Record<
      string,
      { reasoning?: unknown; reasoning_options?: readonly Record<string, unknown>[] }
    >

    expect(models['deepseek-v4-pro']?.reasoning).toBe(true)
    expect(models['deepseek-v4-pro']?.reasoning_options).toEqual([
      { type: 'effort', values: ['low', 'high', 'max'] },
      { type: 'toggle' },
    ])
  })

  it('没声明思考的模型一个 reasoning 字段都不带', () => {
    const document = kimiCatalogCodec.catalogDocument([
      {
        id: 'bare',
        displayName: '裸模型',
        description: '',
        wire: 'openai',
        baseUrl: 'https://example.com',
        apiKeysUrl: 'https://example.com',
        models: [{ id: 'bare-1', displayName: '裸 1', maxContextSize: 1024 }],
      },
    ])

    expect(document).not.toContain('reasoning')
  })
})

describe('kimiCatalogCodec.importDocument', () => {
  it('照 api.json 形状序列化：type、api、剥掉前缀的模型 id', () => {
    const document = JSON.parse(kimiCatalogCodec.importDocument(provider)) as Record<
      string,
      Record<string, unknown>
    >
    const entry = document['moonshot-cn']

    expect(entry?.['type']).toBe('kimi')
    expect(entry?.['api']).toBe('https://api.moonshot.cn/v1')

    const models = entry?.['models'] as Record<string, unknown>
    expect(Object.keys(models)).toEqual(['kimi-k3', 'kimi-k2.6', 'kimi-k2.5'])
  })

  it('effort 与 thinking 各归各的形状', () => {
    const document = JSON.parse(kimiCatalogCodec.importDocument(provider)) as Record<
      string,
      { models: Record<string, { reasoning?: unknown; reasoning_options?: unknown[] }> }
    >
    const models = document['moonshot-cn']?.models

    expect(models?.['kimi-k3']?.reasoning).toBe(true)
    expect(models?.['kimi-k3']?.reasoning_options).toEqual([
      { type: 'effort', values: ['low', 'high', 'max'] },
    ])
    expect(models?.['kimi-k2.6']?.reasoning_options).toEqual([{ type: 'toggle' }])
  })

  it('没起名的模型在写入时就补好显示名', () => {
    const document = JSON.parse(kimiCatalogCodec.importDocument(provider)) as Record<
      string,
      { models: Record<string, { name?: unknown }> }
    >

    expect(document['moonshot-cn']?.models['kimi-k2.5']?.name).toBe('Kimi K2.5')
  })

  it('没有上下文的模型跳过（对方会整条丢掉，不如在这里就跳）', () => {
    expect(kimiCatalogCodec.importDocument(provider)).not.toContain('bare')
  })

  it('文档里一个密钥字段都没有', () => {
    const document = kimiCatalogCodec.importDocument(provider)

    expect(document).not.toContain('apiKey')
    expect(document).not.toContain('api_key')
  })
})

describe('kimiCatalogCodec.defaultModelId', () => {
  it('取第一条进得了导入文档的模型，并剥掉前缀', () => {
    expect(kimiCatalogCodec.defaultModelId(provider)).toBe('kimi-k3')
  })

  it('跳过没有上下文的模型 —— 那几条对方会整条丢掉，挑中就是 exit 1', () => {
    expect(
      kimiCatalogCodec.defaultModelId({
        ...provider,
        models: [
          {
            alias: 'moonshot-cn/bare',
            displayName: 'bare',
            providerId: 'moonshot-cn',
            maxContextSize: undefined,
            capabilities: [],
            supportEfforts: [],
          },
          {
            alias: 'moonshot-cn/kimi-k2.6',
            displayName: 'kimi-k2.6',
            providerId: 'moonshot-cn',
            maxContextSize: 262144,
            capabilities: [],
            supportEfforts: [],
          },
        ],
      }),
    ).toBe('kimi-k2.6')
  })

  it('一条都不合格时缺席，而不是编一个 id', () => {
    expect(kimiCatalogCodec.defaultModelId({ ...provider, models: [] })).toBeUndefined()
  })
})

describe('kimiCatalogCodec.presetDefaultModelId', () => {
  it('内置预设里取第一条带上下文的，id 本来就是裸的', () => {
    const deepseek = builtinAgentProviderById('deepseek')

    if (deepseek === undefined) {
      throw new Error('内置表缺 deepseek')
    }

    expect(kimiCatalogCodec.presetDefaultModelId(deepseek)).toBe('deepseek-v4-pro')
  })

  it('一条都不合格时缺席', () => {
    expect(
      kimiCatalogCodec.presetDefaultModelId({
        id: 'bare',
        displayName: '裸厂商',
        description: '',
        wire: 'openai',
        baseUrl: 'https://example.com',
        apiKeysUrl: 'https://example.com',
        models: [{ id: 'bare-1', displayName: '裸 1' }],
      }),
    ).toBeUndefined()
  })
})
