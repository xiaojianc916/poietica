/*
 * 模型目录：界面那一页要的那四格。
 *
 * 读的是 agent 自己的模型注册表（内置目录 + 用户 models.yml 里的自定义 provider），
 * 写的是 agent 自己的 config.yml —— 那是它的配置真身，它自己热重载。本层不持有
 * 第二份副本，也不认识 provider 的字段名：形状转换只在这里做一次。
 *
 * 增删 provider 还没接（要动 models.yml，是另一件活），所以那几条操作如实报不支持，
 * 而不是回一份没变的快照假装改成功了。
 */

import type { ModelRegistry } from '@oh-my-pi/pi-coding-agent'

import type { ModelCatalogOperation } from './protocol.ts'

/** 界面那一页读的四格，与 crates/agent-client 的 ModelCatalogSnapshot 对应。 */
export interface CatalogSnapshot {
  readonly providers: readonly CatalogProvider[]
  readonly models: readonly CatalogModelEntry[]
  readonly catalog: readonly unknown[]
  readonly defaultModel: string | null
}

interface CatalogProvider {
  readonly id: string
  readonly type: string
  readonly baseUrl: string | null
  readonly defaultModel: string | null
  readonly hasApiKey: boolean
  readonly status: string
  readonly models: readonly string[] | null
}

interface CatalogModelEntry {
  readonly provider: string
  readonly model: string
  readonly displayName: string | null
  readonly maxContextSize: number
  readonly capabilities: readonly string[] | null
  readonly maxOutputSize: number | null
  readonly supportEfforts: readonly string[] | null
  readonly adaptiveThinking: boolean | null
  readonly defaultEffort: string | null
}

/** 一条模型在界面上的名字：provider/id。与 selectors 用的是同一个拼法。 */
export function aliasOf(model: { readonly provider: string; readonly id: string }): string {
  return `${model.provider}/${model.id}`
}

export function snapshotOf(registry: ModelRegistry, defaultModel: string | null): CatalogSnapshot {
  const available = registry.getAvailable('all')
  const known = new Set(available.map((model) => model.provider))

  const models = available.map((model) => ({
    provider: model.provider,
    model: model.id,
    displayName: model.name ?? null,
    maxContextSize: model.contextWindow ?? 0,
    capabilities: null,
    maxOutputSize: model.maxTokens ?? null,
    supportEfforts: null,
    adaptiveThinking: null,
    defaultEffort: null,
  }))

  const providers = [...known].sort().map((id) => ({
    id,
    type: id,
    baseUrl: null,
    defaultModel: null,
    /* 进得了 getAvailable 就说明凭据齐了 —— 这一格正是它筛出来的。 */
    hasApiKey: true,
    status: 'ready',
    models: null,
  }))

  return { providers, models, catalog: [], defaultModel }
}

/**
 * 一次目录操作。
 *
 * `writeDefault` 由调用方注入：写配置是 main.ts 的事（它拿着 Settings），这一层
 * 只管形状。
 */
export async function executeCatalog(
  operation: ModelCatalogOperation,
  registry: ModelRegistry,
  currentDefault: string | null,
  writeDefault: (modelId: string) => Promise<void>,
): Promise<CatalogSnapshot> {
  switch (operation.kind) {
    case 'snapshot':
      return snapshotOf(registry, currentDefault)

    case 'refreshProviders':
      await registry.refresh()
      return snapshotOf(registry, currentDefault)

    case 'setDefault':
      await writeDefault(operation.modelId)
      return snapshotOf(registry, operation.modelId)

    /* 还没接：要写 models.yml，是另一件活。 */
    default:
      throw new Error(`the model catalog does not implement ${operation.kind} yet`)
  }
}
