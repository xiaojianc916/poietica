import { expect, test } from 'bun:test'
import { subscribeToEvent } from './event-subscription'

const settle = (): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, 0)
  })

test('late native listener handles are released exactly once', async () => {
  const registration = Promise.withResolvers<() => void>()
  const attached = Promise.withResolvers<(value: number) => void>()
  const delivered: number[] = []
  const failures: unknown[] = []
  let released = 0
  const stop = subscribeToEvent<number>(
    (handler) => {
      attached.resolve(handler)
      return registration.promise
    },
    (value) => {
      delivered.push(value)
    },
    (cause) => {
      failures.push(cause)
    },
  )
  const receive = await attached.promise
  stop()
  receive(1)
  registration.resolve(() => {
    released += 1
  })
  await settle()
  stop()
  expect(released).toBe(1)
  expect(delivered).toEqual([])
  expect(failures).toEqual([])
})

test('a failing event consumer does not poison later events', async () => {
  const attached = Promise.withResolvers<(value: number) => void>()
  const delivered: number[] = []
  const failures: unknown[] = []
  let released = 0
  const stop = subscribeToEvent<number>(
    (handler) => {
      attached.resolve(handler)
      return Promise.resolve(() => {
        released += 1
      })
    },
    (value) => {
      if (value === 1) {
        throw new Error('Rejected fixture event')
      }
      delivered.push(value)
    },
    (cause) => {
      failures.push(cause)
    },
  )
  const receive = await attached.promise
  receive(1)
  receive(2)
  await settle()
  stop()
  stop()
  expect(failures).toHaveLength(1)
  expect(delivered).toEqual([2])
  expect(released).toBe(1)
})
