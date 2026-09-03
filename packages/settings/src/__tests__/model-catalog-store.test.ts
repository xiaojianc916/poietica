import { describe, expect, it } from 'bun:test'
import type { ModelCatalogData, ModelCatalogPort } from '../model-catalog-store'
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

  it('preserves model declarations by full alias', async () => {
    const catalog: ModelCatalogData = {
      ...DATA,
      models: [
        {
          provider: 'tokenrouter',
          model: 'tokenrouter/z-ai/glm-5.3-free',
          displayName: 'GLM 5.3 (free)',
          maxContextSize: 128000,
          capabilities: ['thinking'],
          supportEfforts: ['low', 'high'],
          defaultEffort: 'high',
        },
      ],
    }
    let written: unknown
    const port: ModelCatalogPort = {
      execute: async (_agentId, operation) => {
        if (operation.kind === 'replace') {
          written = operation.provider
        }
        return catalog
      },
      subscribeInvalidation: async () => () => undefined,
    }
    const store = new ModelCatalogStore(port, 'kimi-code')
    await store.load()
    await store.mutate({
      kind: 'replace',
      providerId: 'tokenrouter',
      provider: {
        providerType: 'openai',
        models: [{ model: 'z-ai/glm-5.3-free', maxContextSize: 128000 }],
      },
    })
    expect(written).toEqual({
      providerType: 'openai',
      models: [
        {
          model: 'z-ai/glm-5.3-free',
          maxContextSize: 128000,
          capabilities: ['thinking'],
          supportEfforts: ['low', 'high'],
        },
      ],
    })
    store.dispose()
  })
})
