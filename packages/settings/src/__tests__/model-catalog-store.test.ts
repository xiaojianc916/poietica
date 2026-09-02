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
})
