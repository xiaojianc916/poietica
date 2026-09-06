import { expect, test } from 'bun:test'
import {
  type ModelCatalogData,
  type ModelCatalogOperation,
  type ModelCatalogPort,
  ModelCatalogStore,
} from './model-catalog-store'

const empty: ModelCatalogData = { providers: [], models: [], catalog: [], defaultModel: null }
const settle = (): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, 0)
  })

test('disposed catalog owners reject new work without touching the port', async () => {
  const calls: ModelCatalogOperation[] = []
  const store = new ModelCatalogStore(
    {
      execute: (_agent, operation) => {
        calls.push(operation)
        return Promise.resolve(empty)
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

test('metadata synchronization cannot resume after its owner is disposed', async () => {
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
  reply.resolve(empty)
  expect(await settled).toHaveProperty('name', 'AbortError')
  expect(calls).toEqual([{ kind: 'snapshot' }])
  expect(store.getSnapshot().data).toBeNull()
})

test('invalidation subscription errors reach the catalog snapshot', async () => {
  const failure = new Error('Subscription unavailable')
  const store = new ModelCatalogStore(
    {
      execute: () => Promise.resolve(empty),
      subscribeInvalidation: () => Promise.reject(failure),
    },
    'agent',
  )
  await settle()
  expect(store.getSnapshot().error).toBe(failure.message)
  store.dispose()
})

test('late invalidation handles release once and cannot initiate refreshes', async () => {
  const registration = Promise.withResolvers<() => void>()
  const attached = Promise.withResolvers<() => void>()
  let reads = 0
  let releases = 0
  const port: ModelCatalogPort = {
    execute: () => {
      reads += 1
      return Promise.resolve(empty)
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

test('a failing release still leaves the catalog permanently inactive', async () => {
  let releases = 0
  const failure = new Error('Release unavailable')
  const store = new ModelCatalogStore(
    {
      execute: () => Promise.resolve(empty),
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
