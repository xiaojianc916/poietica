import { describe, expect, it } from 'bun:test'
import type { ModelCatalogData, ModelCatalogOperation, ModelCatalogPort } from './model'
import { ModelCatalogStore } from './store'

const DATA: ModelCatalogData = {
  providers: [],
  models: [],
  catalog: [],
  defaultModel: null,
}
const settle = (): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, 0)
  })

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
    const store = new ModelCatalogStore(port, 'omp')

    await Promise.all([store.load(), store.load()])
    await store.load()
    expect(calls).toBe(1)

    await store.refresh()
    expect(calls).toBe(2)
    store.dispose()
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
    const store = new ModelCatalogStore(port, 'omp')
    await store.load()
    await store.mutate(operation)
    expect(received).toEqual([{ kind: 'snapshot' }, operation])
    store.dispose()
  })

  it('closes a subscription that resolves after disposal', async () => {
    const registration = Promise.withResolvers<() => void>()
    let disposed = 0
    const port: ModelCatalogPort = {
      execute: async () => DATA,
      subscribeInvalidation: () => registration.promise,
    }
    const store = new ModelCatalogStore(port, 'omp')
    store.dispose()
    registration.resolve(() => {
      disposed += 1
    })
    await settle()
    expect(disposed).toBe(1)
  })

  it('disposed catalog owners reject new work without touching the port', async () => {
    const calls: ModelCatalogOperation[] = []
    const store = new ModelCatalogStore(
      {
        execute: (_agent, operation) => {
          calls.push(operation)
          return Promise.resolve(DATA)
        },
        subscribeInvalidation: () => Promise.resolve(() => undefined),
      },
      'agent',
    )
    store.dispose()
    await expect(store.load()).rejects.toHaveProperty('name', 'AbortError')
    await expect(store.refresh()).rejects.toHaveProperty('name', 'AbortError')
    await expect(store.mutate({ kind: 'setDefault', modelId: 'chosen' })).rejects.toHaveProperty(
      'name',
      'AbortError',
    )
    await expect(store.synchronizeMetadata()).rejects.toHaveProperty('name', 'AbortError')
    expect(() => store.subscribe(() => undefined)).toThrow(DOMException)
    expect(calls).toEqual([])
  })

  it('metadata synchronization cannot resume after its owner is disposed', async () => {
    const reply = Promise.withResolvers<ModelCatalogData>()
    const calls: ModelCatalogOperation[] = []
    const store = new ModelCatalogStore(
      {
        execute: (_agent, operation) => {
          calls.push(operation)
          return reply.promise
        },
        subscribeInvalidation: () => Promise.resolve(() => undefined),
      },
      'agent',
    )
    const pending = store.synchronizeMetadata()
    // Attach handlers eagerly: Bun's expect().rejects hangs when awaited late.
    const settled = pending.then(
      () => new Error('Expected metadata work to stop after disposal'),
      (cause: unknown) => cause,
    )
    store.dispose()
    reply.resolve(DATA)
    expect(await settled).toHaveProperty('name', 'AbortError')
    expect(calls).toEqual([{ kind: 'snapshot' }])
    expect(store.getSnapshot().data).toBeNull()
  })

  it('invalidation subscription errors reach the catalog snapshot', async () => {
    const failure = new Error('Subscription unavailable')
    const store = new ModelCatalogStore(
      {
        execute: () => Promise.resolve(DATA),
        subscribeInvalidation: () => Promise.reject(failure),
      },
      'agent',
    )
    await settle()
    expect(store.getSnapshot().error).toBe(failure.message)
    store.dispose()
  })

  it('late invalidation handles release once and cannot initiate refreshes', async () => {
    const registration = Promise.withResolvers<() => void>()
    const attached = Promise.withResolvers<() => void>()
    let reads = 0
    let releases = 0
    const port: ModelCatalogPort = {
      execute: () => {
        reads += 1
        return Promise.resolve(DATA)
      },
      subscribeInvalidation: (listener) => {
        attached.resolve(listener)
        return registration.promise
      },
    }
    const store = new ModelCatalogStore(port, 'agent')
    const invalidate = await attached.promise
    store.dispose()
    invalidate()
    registration.resolve(() => {
      releases += 1
    })
    await settle()
    store.dispose()
    expect(reads).toBe(0)
    expect(releases).toBe(1)
  })

  it('a failing release still leaves the catalog permanently inactive', async () => {
    let releases = 0
    const failure = new Error('Release unavailable')
    const store = new ModelCatalogStore(
      {
        execute: () => Promise.resolve(DATA),
        subscribeInvalidation: () =>
          Promise.resolve(() => {
            releases += 1
            throw failure
          }),
      },
      'agent',
    )
    await settle()
    expect(() => store.dispose()).toThrow(failure)
    expect(() => store.dispose()).not.toThrow()
    expect(() => store.subscribe(() => undefined)).toThrow(DOMException)
    expect(releases).toBe(1)
  })
})
