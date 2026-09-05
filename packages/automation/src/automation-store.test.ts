import { expect, test } from 'bun:test'
import type { AutomationCatalog } from '@poietica/contract/automation'
import { BLANK_DRAFT } from './automation'
import type { AutomationGateway } from './automation-gateway'
import { createAutomationStore } from './automation-store'

function deferred<T>() {
  let resolve: (value: T) => void = () => {
    throw new Error('Deferred not initialized')
  }
  let reject: (reason: unknown) => void = () => {
    throw new Error('Deferred not initialized')
  }
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

const catalog = (revision: number): AutomationCatalog => ({ revision, automations: [] })
const turn = () =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, 0)
  })

function fixture(overrides: Partial<AutomationGateway> = {}) {
  let receive: (value: AutomationCatalog) => void = () => undefined
  let sequence = 0
  const failures: unknown[] = []
  const gateway: AutomationGateway = {
    loadCatalog: () => Promise.resolve(catalog(1)),
    create: () => Promise.resolve(catalog(2)),
    update: () => Promise.resolve(catalog(2)),
    enable: () => Promise.resolve(catalog(2)),
    remove: () => Promise.resolve(catalog(2)),
    run: () => Promise.resolve(catalog(2)),
    cancel: () => Promise.resolve(catalog(2)),
    preview: () => Promise.resolve({ nextRunAt: null, problem: null }),
    watchCatalog: (listener) => {
      receive = listener
      return Promise.resolve(() => undefined)
    },
    ...overrides,
  }
  const store = createAutomationStore(gateway, {
    createId: () => String(++sequence),
    report: (_operation, cause) => {
      failures.push(cause)
    },
  })
  return { store, failures, receive: (value: AutomationCatalog) => receive(value) }
}

test('subscribe precedes read and native revisions win over response order', async () => {
  const read = deferred<AutomationCatalog>()
  const receipt = deferred<AutomationCatalog>()
  let subscriptions = 0
  const fixtureValue = fixture({
    loadCatalog: () => {
      expect(subscriptions).toBe(1)
      return read.promise
    },
    create: () => receipt.promise,
    watchCatalog: (receive) => {
      subscriptions += 1
      receive(catalog(7))
      return Promise.resolve(() => undefined)
    },
  })
  const stop = fixtureValue.store.start()
  try {
    await turn()
    read.resolve(catalog(2))
    await turn()
    const submitted = fixtureValue.store.create(BLANK_DRAFT)
    receipt.resolve(catalog(3))
    await submitted
    expect(fixtureValue.store.getSnapshot().revision).toBe(7)
  } finally {
    stop()
  }
})

test('a read failure is not an empty successful catalog', async () => {
  const { store, failures } = fixture({
    loadCatalog: () => Promise.reject(new Error('disk unavailable')),
  })
  expect(await store.refresh()).toBe(false)
  expect(store.getSnapshot().loaded).toBe(false)
  expect(store.getSnapshot().revision).toBeNull()
  expect(store.getSnapshot().error).toContain('disk unavailable')
  expect(failures).toHaveLength(1)
})

test('a subscription acquired after disposal is released without applying its response', async () => {
  const subscription = deferred<() => void>()
  let released = 0
  const { store } = fixture({ watchCatalog: () => subscription.promise })
  const stop = store.start()
  stop()
  subscription.resolve(() => {
    released += 1
  })
  await turn()
  expect(released).toBe(1)
  expect(store.getSnapshot().loaded).toBe(false)
})

test('lost manual receipts reuse a request identity, confirmed repeats do not', async () => {
  const ids: string[] = []
  let reject = true
  const { store } = fixture({
    run: (_id, requestId) => {
      ids.push(requestId)
      return reject ? Promise.reject(new Error('receipt lost')) : Promise.resolve(catalog(4))
    },
  })
  expect(await store.runNow('task')).toBe(false)
  reject = false
  expect(await store.runNow('task')).toBe(true)
  expect(await store.runNow('task')).toBe(true)
  expect(ids).toEqual(['1', '1', '2'])
})

test('saving forwards the revision captured by the editor instead of the latest projection', async () => {
  let savedRevision = 0
  const { store, receive } = fixture({
    update: (update) => {
      savedRevision = update.expectedRevision
      return Promise.resolve(catalog(10))
    },
  })
  const stop = store.start()
  try {
    await turn()
    receive(catalog(9))
    await store.update('task', 3, BLANK_DRAFT, false)
    expect(savedRevision).toBe(3)
  } finally {
    stop()
  }
})

test('a response from an earlier observation lifetime cannot overwrite the current catalog', async () => {
  const first = deferred<AutomationCatalog>()
  let reads = 0
  const { store } = fixture({
    loadCatalog: () => (++reads === 1 ? first.promise : Promise.resolve(catalog(8))),
  })
  const stopFirst = store.start()
  await turn()
  stopFirst()
  const stopSecond = store.start()
  try {
    await turn()
    first.resolve(catalog(99))
    await turn()
    expect(store.getSnapshot().revision).toBe(8)
  } finally {
    stopSecond()
  }
})
