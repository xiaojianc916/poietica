import type { ModelCatalogWire } from '@poietica/contract/settings'
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
export type CatalogModel = CatalogProvider['models'][number]

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
  | { readonly kind: 'importRegistry'; readonly url: string; readonly apiKey?: string }
  | { readonly kind: 'setDefault'; readonly modelId: string }
  | { readonly kind: 'patchConfig'; readonly patch: Readonly<Record<string, unknown>> }

export interface ModelCatalogPort {
  readonly execute: (agentId: string, operation: ModelCatalogOperation) => Promise<ModelCatalogData>
  readonly subscribeInvalidation: (listener: () => void) => Promise<() => void>
}
