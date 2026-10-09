/*
 * 模型目录的数据词汇。**迁移**自 legacy \`packages/settings/src/model-catalog/model.ts\` 与
 * \`@poietica/contract/settings\` 的 ModelCatalogWire 一族：形状逐字保留（组件因此一个字段都不用改），
 * 但产地换成新架构 —— 由 models 契约的 ProviderInfo / ModelInfo 折出来（见 \`catalog-store.ts\`）。
 */
/** 原生侧线上形状（原 ModelCatalogWire）：字段与 legacy 一字不差，好让组件一个字段都不用改。 */
export interface ProviderDto {
  readonly id: string
  readonly providerType: string
  readonly baseUrl: string | null
  readonly defaultModel: string | null
  readonly hasApiKey: boolean
  readonly status: string
  readonly models: readonly string[] | null
}
export interface ModelDto {
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
export interface CatalogModelDto {
  readonly id: string
  readonly name: string | null
  readonly maxContextSize: number
  readonly capabilities: readonly string[] | null
  readonly reasoning: boolean
}
export interface CatalogProviderDto {
  readonly id: string
  readonly name: string
  readonly wireType: string | null
  readonly guessed: boolean
  readonly needsBaseUrl: boolean
  readonly rejected: boolean
  readonly rejectReason: string | null
  readonly envKey: string | null
  readonly models: readonly CatalogModelDto[]
}
export interface ModelCatalogWire {
  readonly providers: readonly ProviderDto[]
  readonly models: readonly ModelDto[]
  readonly catalog: readonly CatalogProviderDto[]
  readonly defaultModel: string | null
}

export interface ProviderModelInput {
  readonly model: string
  readonly maxContextSize: number
  readonly displayName?: string
  readonly capabilities?: readonly string[]
  readonly maxOutputSize?: number
  readonly supportEfforts?: readonly string[]
  readonly adaptiveThinking?: boolean
}

export interface ProviderInput {
  readonly id: string
  readonly providerType: string
  readonly apiKey?: string
  readonly baseUrl?: string
  readonly defaultModel?: string
  readonly models: readonly ProviderModelInput[]
}

export interface ProviderReplacement extends Omit<ProviderInput, 'id'> {
  readonly newId?: string
}

type Snapshot<T> = T extends readonly unknown[]
  ? ReadonlyArray<Snapshot<T[number]>>
  : T extends object
    ? { readonly [Key in keyof T]: Snapshot<T[Key]> }
    : T
export type ModelCatalogData = Snapshot<ModelCatalogWire>
export type ModelProvider = ModelCatalogData['providers'][number]
export type ModelDescriptor = ModelCatalogData['models'][number]
export type CatalogProvider = ModelCatalogData['catalog'][number]

export function modelAlias(providerId: string, modelId: string): string {
  return `${providerId}/${modelId}`
}

export interface ModelCatalogSnapshot {
  readonly data: ModelCatalogData | null
  readonly loading: boolean
  readonly mutating: boolean
  readonly error: string | null
}

export type ModelCatalogOperation =
  | { readonly kind: 'snapshot' }
  | { readonly kind: 'refreshProviders' }
  | { readonly kind: 'create'; readonly provider: ProviderInput }
  | {
      readonly kind: 'replace'
      readonly providerId: string
      readonly provider: ProviderReplacement
    }
  | { readonly kind: 'delete'; readonly providerId: string }
  | {
      readonly kind: 'importCatalog'
      readonly catalogId: string
      readonly apiKey?: string
      readonly baseUrl?: string
      readonly id?: string
    }
  | { readonly kind: 'setDefault'; readonly modelId: string }

export interface ModelCatalogPort {
  readonly execute: (operation: ModelCatalogOperation) => Promise<ModelCatalogData>
  readonly subscribeInvalidation: (listener: () => void) => Promise<() => void>
}

/** 目录 store 的读法（实现是 catalog-store.ts 里那个类） */
export interface ModelCatalogStore {
  readonly subscribe: (listener: () => void) => () => void
  readonly getSnapshot: () => ModelCatalogSnapshot
  readonly load: () => Promise<void>
  readonly refresh: () => Promise<void>
  readonly refreshFromSources: () => Promise<void>
  readonly mutate: (operation: Exclude<ModelCatalogOperation, { readonly kind: 'snapshot' }>) => Promise<void>
  readonly setDefaultModel: (modelId: string) => Promise<void>
  dispose(): void
}
