import { describe, expect, it } from 'bun:test'
import type {
  ModelCatalogData,
  ModelCatalogOperation,
  ModelCatalogPort,
} from '../model-catalog-store'
import { ModelCatalogStore } from '../model-catalog-store'

const DATA: ModelCatalogData = {
  providers: [],
  models: [],
  catalog: [],
  defaultModel: null,
}

describe('ModelCatalogStore', () => {
  it('reuses the process snapshot until an explicit refresh', async () => {
    let calls = 0
    const port: ModelCatalogPort = {
      execute: () => {
        calls += 1
        return Promise.resolve(DATA)
      },
      subscribeInvalidation: async () => () => undefined,
    }
    const store = new ModelCatalogStore(port, 'kimi-code')

    await Promise.all([store.load(), store.load()])
    await store.load()
    expect(calls).toBe(1)

    await store.refresh()
    expect(calls).toBe(2)
    store.dispose()
  })

  it('closes a subscription that resolves after disposal', async () => {
    let resolveSubscription!: (dispose: () => void) => void
    let disposed = 0
    const pending = new Promise<() => void>((resolve) => {
      resolveSubscription = resolve
    })
    const port: ModelCatalogPort = {
      execute: async () => DATA,
      subscribeInvalidation: () => pending,
    }
    const store = new ModelCatalogStore(port, 'kimi-code')
    store.dispose()
    resolveSubscription(() => {
      disposed += 1
    })
    await Promise.resolve()
    await Promise.resolve()
    expect(disposed).toBe(1)
  })

  it('forwards writes without deriving metadata from cached state', async () => {
    const operation: ModelCatalogOperation = {
      kind: 'replace',
      providerId: 'tokenrouter',
      provider: {
        providerType: 'openai',
        models: [
          {
            model: 'z-ai/glm-5.3-free',
            maxContextSize: 128000,
            capabilities: ['thinking'],
            maxOutputSize: 65536,
            supportEfforts: ['low', 'high'],
            adaptiveThinking: true,
          },
        ],
      },
    }
    const received: ModelCatalogOperation[] = []
    const port: ModelCatalogPort = {
      execute: (_agentId, operation) => {
        received.push(operation)
        return Promise.resolve(DATA)
      },
      subscribeInvalidation: async () => () => undefined,
    }
    const store = new ModelCatalogStore(port, 'kimi-code')
    await store.load()
    await store.mutate(operation)
    expect(received).toEqual([{ kind: 'snapshot' }, operation])
    store.dispose()
  })
})
