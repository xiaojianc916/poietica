import { expect, test } from 'bun:test'
import { DEFAULT_SURFACE_ID } from './surface-registry'
import { createWorkbenchPersistence } from './workbench-persistence'
import { createWorkbenchSessionController } from './workbench-session-controller'

function deferred() {
  let release: () => void = () => {
    throw new Error('Deferred promise was not initialized.')
  }
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release: () => release() }
}

test('serializes writes and retains only the latest pending complete snapshot', async () => {
  const started = deferred()
  const finish = deferred()
  const written: string[] = []
  let active = 0
  let maximum = 0
  const persistence = createWorkbenchPersistence(async (document) => {
    active += 1
    maximum = Math.max(maximum, active)
    if (document === 'first') {
      started.release()
      await finish.promise
    }
    written.push(document)
    active -= 1
  }, undefined)
  persistence.enqueue('first')
  await started.promise
  persistence.enqueue('second')
  persistence.enqueue('last')
  const flushed = persistence.flush()
  finish.release()
  await flushed
  expect(written).toEqual(['first', 'last'])
  expect(maximum).toBe(1)
})

test('a failed final write is reported and remains observable to its owner', async () => {
  const cause = new Error('disk rejected write')
  const reported: unknown[] = []
  const persistence = createWorkbenchPersistence(
    () => Promise.reject(cause),
    (error) => reported.push(error),
  )
  persistence.enqueue('document')
  await expect(persistence.flush()).rejects.toBe(cause)
  expect(reported).toEqual([cause])
})

test('a later successful snapshot resolves an earlier persistence failure', async () => {
  let reject = true
  const persistence = createWorkbenchPersistence(() => {
    if (reject) {
      throw new Error('unavailable')
    }
  }, undefined)
  persistence.enqueue('first')
  await expect(persistence.flush()).rejects.toThrow('unavailable')
  reject = false
  persistence.enqueue('latest')
  await persistence.flush()
})

test('controller disposal waits for its final document and closes the write entrance', async () => {
  const finish = deferred()
  const started = deferred()
  const store = createWorkbenchSessionController({
    restored: JSON.stringify({
      entries: [{ kind: 'conversation', threadId: 'fixture-thread', title: 'Conversation' }],
      activeIndex: 0,
    }),
    persist: async () => {
      started.release()
      await finish.promise
    },
  })
  store.openSurface({ surfaceId: DEFAULT_SURFACE_ID })
  await started.promise
  let stopped = false
  const stopping = store.dispose().then(() => {
    stopped = true
  })
  await Promise.resolve()
  expect(stopped).toBe(false)
  expect(() => store.openSurface({ surfaceId: DEFAULT_SURFACE_ID })).toThrow('disposed')
  expect(() => store.subscribe(() => undefined)).toThrow('disposed')
  finish.release()
  await stopping
  expect(stopped).toBe(true)
})
