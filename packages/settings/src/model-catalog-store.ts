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

export interface ModelProvider {
  readonly id: string
  readonly providerType: string
  readonly baseUrl: string | null
  readonly defaultModel: string | null
  readonly hasApiKey: boolean
  readonly status: string
  readonly models: readonly string[] | null
}

export interface ModelDescriptor {
  readonly provider: string
  readonly model: string
  readonly displayName: string | null
  readonly maxContextSize: number
  readonly capabilities: readonly string[] | null
  readonly supportEfforts: readonly string[] | null
  readonly defaultEffort: string | null
}

export interface CatalogModel {
  readonly id: string
  readonly name: string | null
  readonly maxContextSize: number
  readonly capabilities: readonly string[] | null
  readonly reasoning: boolean
}

export interface CatalogProvider {
  readonly id: string
  readonly name: string
  readonly wireType: string | null
  readonly guessed: boolean
  readonly needsBaseUrl: boolean
  readonly rejected: boolean
  readonly rejectReason: string | null
  readonly envKey: string | null
  readonly models: readonly CatalogModel[]
}

export interface ModelCatalogData {
  readonly providers: readonly ModelProvider[]
  readonly models: readonly ModelDescriptor[]
  readonly catalog: readonly CatalogProvider[]
  readonly defaultModel: string | null
}

export interface ModelCatalogSnapshot {
  readonly data: ModelCatalogData | null
  readonly loading: boolean
  readonly mutating: boolean
  readonly error: string | null
}

export type ModelCatalogOperation =
  | { readonly kind: 'snapshot' }
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

const EMPTY: ModelCatalogSnapshot = Object.freeze({
  data: null,
  loading: false,
  mutating: false,
  error: null,
})

export class ModelCatalogStore {
  readonly #port: ModelCatalogPort
  readonly #agentId: string
  readonly #listeners = new Set<() => void>()
  readonly #committed = new Set<() => void>()
  #snapshot = EMPTY
  #generation = 0
  #loading: Promise<void> | null = null
  #dispose: (() => void) | null = null
  #disposed = false

  constructor(port: ModelCatalogPort, agentId: string) {
    this.#port = port
    this.#agentId = agentId
    void port
      .subscribeInvalidation(() => void this.refresh())
      .then(
        (dispose) => {
          if (this.#disposed) {
            dispose()
            return
          }
          this.#dispose = dispose
        },
        () => undefined,
      )
  }

  readonly getSnapshot = (): ModelCatalogSnapshot => this.#snapshot

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  readonly subscribeCommitted = (listener: () => void): (() => void) => {
    this.#committed.add(listener)
    return () => this.#committed.delete(listener)
  }

  dispose(): void {
    this.#disposed = true
    this.#generation += 1
    this.#dispose?.()
    this.#dispose = null
    this.#listeners.clear()
    this.#committed.clear()
  }

  load = (): Promise<void> => {
    if (this.#snapshot.data !== null) {
      return Promise.resolve()
    }
    if (this.#loading !== null) {
      return this.#loading
    }
    const pending = this.refresh()
    this.#loading = pending
    void pending.finally(() => {
      if (this.#loading === pending) {
        this.#loading = null
      }
    })
    return pending
  }

  refresh = async (): Promise<void> => {
    const generation = ++this.#generation
    this.#publish({ ...this.#snapshot, loading: true, error: null })
    try {
      const data = await this.#port.execute(this.#agentId, { kind: 'snapshot' })
      this.#commit(generation, data)
    } catch (cause) {
      if (generation === this.#generation) {
        this.#publish({ ...this.#snapshot, loading: false, error: describe(cause) })
      }
    }
  }

  mutate = async (
    operation: Exclude<ModelCatalogOperation, { readonly kind: 'snapshot' }>,
  ): Promise<void> => {
    const generation = ++this.#generation
    this.#publish({ ...this.#snapshot, mutating: true, error: null })
    try {
      const data = await this.#port.execute(this.#agentId, this.#declared(operation))
      this.#commit(generation, data)
    } catch (cause) {
      if (generation === this.#generation) {
        this.#publish({ ...this.#snapshot, mutating: false, error: describe(cause) })
      }
      throw cause
    }
  }

  setDefaultModel(modelId: string): Promise<void> {
    return this.mutate({ kind: 'setDefault', modelId })
  }

  /* provider 覆盖是整份替换：表单只填可编辑的三项，声明元数据从目录快照补回。 */
  #declared(
    operation: Exclude<ModelCatalogOperation, { readonly kind: 'snapshot' }>,
  ): Exclude<ModelCatalogOperation, { readonly kind: 'snapshot' }> {
    const declared = this.#snapshot.data?.models ?? []
    if (operation.kind === 'create') {
      return {
        ...operation,
        provider: {
          ...operation.provider,
          models: withDeclared(operation.provider.models, declared, operation.provider.id),
        },
      }
    }
    if (operation.kind === 'replace') {
      return {
        ...operation,
        provider: {
          ...operation.provider,
          models: withDeclared(operation.provider.models, declared, operation.providerId),
        },
      }
    }
    return operation
  }

  #commit(generation: number, data: ModelCatalogData): void {
    if (generation !== this.#generation) {
      return
    }
    this.#publish({ data: freezeData(data), loading: false, mutating: false, error: null })
    for (const listener of this.#committed) {
      listener()
    }
  }

  #publish(snapshot: ModelCatalogSnapshot): void {
    this.#snapshot = Object.freeze(snapshot)
    for (const listener of this.#listeners) {
      listener()
    }
  }
}

/* 目录快照是模型声明的唯一真相：表单没有的字段回填，不允许被覆盖写清空。 */
function withDeclared(
  models: readonly ProviderModelInput[],
  declared: readonly ModelDescriptor[],
  providerId: string,
): readonly ProviderModelInput[] {
  const source = new Map(
    declared
      .filter((entry) => entry.provider === providerId)
      .map((entry) => [entry.model, entry] as const),
  )
  return models.map((model) => {
    const found = source.get(model.model)
    if (found === undefined) {
      return model
    }
    return {
      ...model,
      ...(model.capabilities === undefined && found.capabilities !== null
        ? { capabilities: found.capabilities }
        : {}),
      ...(model.supportEfforts === undefined && found.supportEfforts !== null
        ? { supportEfforts: found.supportEfforts }
        : {}),
    }
  })
}

function freezeData(data: ModelCatalogData): ModelCatalogData {
  return Object.freeze({
    ...data,
    providers: Object.freeze([...data.providers]),
    models: Object.freeze([...data.models]),
    catalog: Object.freeze([...data.catalog]),
  })
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}
