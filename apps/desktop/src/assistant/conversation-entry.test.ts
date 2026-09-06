import { expect, mock, test } from 'bun:test'
import { createConversationEntry } from './conversation-entry'

function deferred<T>() {
  let resolve: (value: T) => void = () => {
    throw new Error('Deferred promise is not ready.')
  }
  let reject: (cause: unknown) => void = () => {
    throw new Error('Deferred promise is not ready.')
  }
  const promise = new Promise<T>((accept, refuse) => {
    resolve = accept
    reject = refuse
  })
  return { promise, resolve, reject }
}
function fixture(open: (id: string, root: string) => Promise<string | null>) {
  let sequence = 0
  const createProjectless = mock(async () => '/scratch')
  const entry = createConversationEntry({
    createId: () => String(++sequence),
    readRoot: () => null,
    createProjectless,
    open,
  })
  return { entry, createProjectless }
}

test('false is retryable, projectless allocation is reused, and a prepared identity is not recreated', async () => {
  let calls = 0
  const { entry, createProjectless } = fixture(async (id) => {
    calls += 1
    return calls === 1 ? null : id
  })
  const identity = entry.getSnapshot().threadId
  expect(await entry.prepare()).toBe(false)
  expect(await entry.prepare()).toBe(true)
  expect(await entry.prepare()).toBe(true)
  expect(calls).toBe(2)
  expect(createProjectless).toHaveBeenCalledTimes(1)
  expect(entry.getSnapshot()).toEqual({ threadId: identity, started: true })
  entry.dispose()
})

test('concurrent preparation shares only its entry attempt and rejection releases it', async () => {
  const attempt = deferred<string | null>()
  let calls = 0
  const { entry } = fixture((id) => {
    calls += 1
    return calls === 1 ? attempt.promise : Promise.resolve(id)
  })
  const first = entry.prepare()
  expect(entry.prepare()).toBe(first)
  const rejected = expect(first).rejects.toThrow('unavailable')
  attempt.reject(new Error('unavailable'))
  await rejected
  expect(await entry.prepare()).toBe(true)
  expect(calls).toBe(2)
  entry.dispose()
})

test('obsolete native completion cannot change the next entry', async () => {
  const attempt = deferred<string | null>()
  const reached = deferred<void>()
  const { entry } = fixture(() => {
    reached.resolve()
    return attempt.promise
  })
  const identity = entry.getSnapshot().threadId
  const pending = entry.prepare()
  await reached.promise
  entry.begin()
  const replacement = entry.getSnapshot()
  attempt.resolve(identity)
  expect(await pending).toBe(false)
  expect(entry.getSnapshot()).toBe(replacement)
  expect(replacement.started).toBe(false)
  entry.dispose()
})

test('subscription teardown does not define entry identity; application disposal does', async () => {
  const { entry } = fixture(async (id) => id)
  const initial = entry.getSnapshot()
  const stop = entry.subscribe(() => undefined)
  stop()
  const again = entry.subscribe(() => undefined)
  expect(entry.getSnapshot()).toBe(initial)
  again()
  entry.dispose()
  expect(await entry.prepare()).toBe(false)
  expect(entry.getSnapshot()).toBe(initial)
})
