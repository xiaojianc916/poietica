import { agentBareModelId, agentModelDisplayName } from '../model-display'
import type { AgentProviderPreset } from '../provider-presets'
import type { AgentProviderState } from '../provider-state'
import { kimiCatalogAddArgs } from './catalog-add'

/*
 * Kimi Code 的 provider 目录编解码器。
 */

/*
 * 把内置表序列化成 agent 目录命令认的 api.json 形状。
 *
 * 形状的判据是对方解析器逐字读什么（@moonshot-ai/kosong 的 src/catalog.ts）：顶层是
 * id → 厂商的表；厂商条目里 type 是显式协议（在场就以它为准）、api 是接口地址、models
 * 是 id → 模型的表；模型条目里 id 与 limit.context 是硬门槛 —— 缺一个正整数 context，
 * 那条模型就被对方整条丢掉（catalogModelToCapability）。name 只是显示名。除此之外的
 * 字段没有证据的一律不写；reasoning 与 reasoning_options 有逐字证据，在写之列。
 *
 * 产物经 IPC 交给原生侧，绑在一次性 loopback 服务上，经官方 --url 喂给 catalog add。
 * 不含密钥：密钥走环境变量，从来不进这份文档。
 */
function catalogDocument(presets: readonly AgentProviderPreset[]): string {
  const catalog: Record<string, unknown> = {}

  for (const preset of presets) {
    const models: Record<string, unknown> = {}

    for (const model of preset.models) {
      /*
       * reasoning_options 的形状照对方逐字的读法：{type:'effort', values} 进档位表
       * （'none' 那一档被它当成「关」），{type:'toggle'} 表示可整个关掉。有任一声明
       * 就补 reasoning: true —— 它的 thinking 判定是三选一，写齐不留死角。
       */
      const reasoningOptions: Record<string, unknown>[] = []

      if (model.thinking?.efforts !== undefined) {
        reasoningOptions.push({ type: 'effort', values: [...model.thinking.efforts] })
      }

      if (model.thinking?.toggle === true) {
        reasoningOptions.push({ type: 'toggle' })
      }

      models[model.id] = {
        id: model.id,
        name: model.displayName,
        ...(model.maxContextSize === undefined ? {} : { limit: { context: model.maxContextSize } }),
        ...(reasoningOptions.length === 0
          ? {}
          : { reasoning: true, reasoning_options: reasoningOptions }),
      }
    }

    catalog[preset.id] = {
      id: preset.id,
      name: preset.displayName,
      api: preset.baseUrl,
      type: preset.wire,
      models,
    }
  }

  return JSON.stringify(catalog)
}

/*
 * 把一家已配置的 provider 序列化成 agent 目录命令认的 api.json 形状。
 *
 * 用途只有一个：一次性导入。原料是 provider list 的快照（模型 id、上下文、
 * capabilities、effort 全在里面），写入仍走官方的 catalog add。没有正整数上下文的
 * 模型跳过：对方的 catalogModelToCapability 会把它们整条丢掉，不如在这里就跳。
 * 密钥永不进这份文档。
 */
function importDocument(provider: AgentProviderState): string {
  const models: Record<string, unknown> = {}

  for (const model of provider.models) {
    if (model.maxContextSize === undefined) {
      continue
    }

    const reasoningOptions: Record<string, unknown>[] = []

    if (model.supportEfforts.length > 0) {
      reasoningOptions.push({ type: 'effort', values: [...model.supportEfforts] })
    }

    if (
      model.capabilities.includes('thinking') &&
      !model.capabilities.includes('always_thinking')
    ) {
      reasoningOptions.push({ type: 'toggle' })
    }

    const reasoning = reasoningOptions.length > 0 || model.capabilities.includes('always_thinking')
    const inputs = ['image_in', 'video_in', 'audio_in'].flatMap((capability) =>
      model.capabilities.includes(capability) ? [capability.slice(0, -3)] : [],
    )
    const bare = agentBareModelId(model.alias, provider.id)

    models[bare] = {
      id: bare,
      name: agentModelDisplayName(model),
      limit: { context: model.maxContextSize },
      ...(reasoning ? { reasoning: true } : {}),
      ...(reasoningOptions.length > 0 ? { reasoning_options: reasoningOptions } : {}),
      ...(inputs.length > 0 ? { modalities: { input: inputs } } : {}),
    }
  }

  return JSON.stringify({
    [provider.id]: {
      id: provider.id,
      name: provider.id,
      ...(provider.baseUrl === undefined ? {} : { api: provider.baseUrl }),
      ...(provider.type === undefined ? {} : { type: provider.type }),
      models,
    },
  })
}

/*
 * 这一家该拿哪个模型当 default_model。
 *
 * 为什么它是必填而不是偏好：官方 catalog add 把它当硬校验 ——
 * handleCatalogAdd 的 models.some((m) => m.id === opts.defaultModel) 落空就 exit 1，
 * 于是一次导入要么带着一个真实存在的 default_model，要么整条不算数。
 *
 * 候选只在「进得了导入文档」的那几条里挑：--default-model 的校验名单是对方从目录
 * 里解析出来的模型（handleCatalogAdd 的 models.some(m => m.id === opts.defaultModel)），
 * 而没有正整数上下文的模型在 importDocument 那一步已经被跳过。挑一条被跳过的，
 * 整次导入会以 exit 1 收场。两处过滤必须是同一条，所以这里不另写判据。
 *
 * 一条都不合格时缺席 —— 编一个 id 出来只会把失败推迟到对方的校验里。
 */
function defaultModelId(provider: AgentProviderState): string | undefined {
  const first = provider.models.find((model) => model.maxContextSize !== undefined)

  return first === undefined ? undefined : agentBareModelId(first.alias, provider.id)
}

/*
 * 同一个问题的另一半：手上只有内置预设（这一家还没配过，provider list 里根本没有
 * 它）时，该拿哪个模型当 default_model。
 *
 * 判据与上面那个函数逐字相同，而且必须相同：没有正整数上下文的模型，catalogDocument
 * 写出的条目就没有 limit.context，对方的 catalogModelToCapability 会把它整条丢掉，
 * 随后 handleCatalogAdd 的 models.some((m) => m.id === opts.defaultModel) 落空，整次
 * 写入以 exit 1 收场。两处过滤是同一条，所以这里不另写判据，只换一种输入。
 *
 * 之所以不是同一个函数：那一个吃 provider list 的快照（AgentProviderState，别名带
 * provider/ 前缀，要剥），这一个吃内置预设（AgentProviderPreset，id 本来就是裸的）。
 * 合并只能靠再加一层参数，那比两行贵。
 */
function presetDefaultModelId(preset: AgentProviderPreset): string | undefined {
  return preset.models.find((model) => model.maxContextSize !== undefined)?.id
}

/* 这一家对外的全部：一个编解码器。 */
export const kimiCatalogCodec = {
  catalogDocument,
  importDocument,
  defaultModelId,
  presetDefaultModelId,
  catalogAddArgs: kimiCatalogAddArgs,
}
