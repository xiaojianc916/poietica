import { expect, mock, test } from 'bun:test'
import { observeMaximizedState } from './maximized-state'

function deferred<T>() {
  let resolve: (value: T) => void = () => {
    throw new Error('Deferred promise is not ready.')
  }
  const promise = new Promise<T>((accept) => {
    resolve = accept
  })
  return { promise, resolve }
}

test('subscription precedes the query and a newer event defeats an outstanding snapshot', async () => {
  const query = deferred<boolean>()
  const asked = deferred<void>()
  const events: string[] = []
  let emit: (value: boolean) => void = () => {
    throw new Error('Listener is not installed.')
  }
  const publish = mock((_value: boolean) => undefined)
  const stop = observeMaximizedState(
    {
      onMaximizedChanged: async (listen) => {
        events.push('subscribe')
        emit = listen
        return () => {
          events.push('unsubscribe')
        }
      },
      isMaximized: () => {
        events.push('query')
        asked.resolve()
        return query.promise
      },
    },
    publish,
    () => undefined,
  )
  await asked.promise
  emit(true)
  query.resolve(false)
  await query.promise
  await Promise.resolve()
  expect(events.slice(0, 2)).toEqual(['subscribe', 'query'])
  expect(publish).toHaveBeenCalledTimes(1)
  expect(publish).toHaveBeenCalledWith(true)
  stop()
  emit(false)
  expect(publish).toHaveBeenCalledTimes(1)
  expect(events.at(-1)).toBe('unsubscribe')
})

test('shutdown before listener registration still releases the listener and never starts a query', async () => {
  const registration = deferred<() => void>()
  const released = deferred<void>()
  const read = mock(async () => false)
  const detach = mock(() => {
    released.resolve()
  })
  const publish = mock((_value: boolean) => undefined)
  const stop = observeMaximizedState(
    {
      onMaximizedChanged: () => registration.promise,
      isMaximized: read,
    },
    publish,
    () => undefined,
  )
  stop()
  registration.resolve(detach)
  await released.promise
  expect(detach).toHaveBeenCalledTimes(1)
  expect(read).not.toHaveBeenCalled()
  expect(publish).not.toHaveBeenCalled()
})
