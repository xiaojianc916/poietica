import type {
  ModelCatalogData,
  ModelCatalogOperation,
  ModelCatalogPort,
  ModelCatalogSnapshot,
} from './model'

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
      .subscribeInvalidation(() => {
        if (!this.#disposed) {
          void this.refresh()
        }
      })
      .then(
        (dispose) => {
          if (this.#disposed) {
            dispose()
            return
          }
          this.#dispose = dispose
        },
        (cause: unknown) => {
          if (!this.#disposed) {
            this.#publish({ ...this.#snapshot, error: describe(cause) })
          }
        },
      )
  }

  readonly getSnapshot = (): ModelCatalogSnapshot => this.#snapshot

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#requireActive()
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  readonly subscribeCommitted = (listener: () => void): (() => void) => {
    this.#requireActive()
    this.#committed.add(listener)
    return () => this.#committed.delete(listener)
  }

  dispose(): void {
    if (this.#disposed) {
      return
    }
    this.#disposed = true
    this.#generation += 1
    const release = this.#dispose
    this.#dispose = null
    this.#listeners.clear()
    this.#committed.clear()
    release?.()
  }

  load = (): Promise<void> => {
    if (this.#disposed) {
      return Promise.reject(stoppedCatalog())
    }
    if (this.#snapshot.data !== null) {
      return Promise.resolve()
    }
    if (this.#loading !== null) {
      return this.#loading
    }
    const pending = this.refresh()
    this.#loading = pending
    const settle = () => {
      if (this.#loading === pending) {
        this.#loading = null
      }
    }
    void pending.then(settle, settle)
    return pending
  }

  refresh = async (): Promise<void> => {
    this.#requireActive()
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
    this.#requireActive()
    const generation = ++this.#generation
    this.#publish({ ...this.#snapshot, mutating: true, error: null })
    try {
      const data = await this.#port.execute(this.#agentId, operation)
      this.#commit(generation, data)
    } catch (cause) {
      if (generation === this.#generation) {
        this.#publish({ ...this.#snapshot, mutating: false, error: describe(cause) })
      }
      throw cause
    }
  }

  /**
   * 让 agent 自己去重取模型目录（在线目录 + 端点发现），再回一张新快照。
   *
   * 不在这条线上补元数据：模型的档位、上下文、能力位只有一个产地 —— agent 自己的
   * 注册表（ADR 0053）。我们这侧再拿一份目录去"补全"它，就是第二个事实。
   */
  refreshFromSources = (): Promise<void> => this.mutate({ kind: 'refreshProviders' })

  setDefaultModel(modelId: string): Promise<void> {
    return this.mutate({ kind: 'setDefault', modelId })
  }

  #requireActive(): void {
    if (this.#disposed) {
      throw stoppedCatalog()
    }
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

function stoppedCatalog(): DOMException {
  return new DOMException('Model catalog is disposed.', 'AbortError')
}
