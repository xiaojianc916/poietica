import { expect, mock, test } from 'bun:test'
import type { Preference } from '@poietica/external-store'
import { createWorkspaceRoots } from './roots'

function preference(initial: string | null): Preference<string | null> {
  let value = initial
  const listeners = new Set<() => void>()
  return {
    read: () => value,
    readFallback: () => null,
    subscribe: (listen) => {
      listeners.add(listen)
      return () => {
        listeners.delete(listen)
      }
    },
    write: (next) => {
      value = next
      for (const listen of listeners) {
        listen()
      }
    },
  }
}

test('construction has no platform I/O and verification runs once', async () => {
  const readHome = mock(async () => '/home/person')
  const owner = createWorkspaceRoots({
    active: preference(null),
    home: preference(null),
    readHome,
    onHomeFailure: mock(),
  })
  expect(readHome).not.toHaveBeenCalled()
  const first = owner.start()
  expect(owner.start()).toBe(first)
  expect(await first).toBe('/home/person')
  expect(readHome).toHaveBeenCalledTimes(1)
})

test('cache is immediate but later readiness reads the verified value', async () => {
  const completion = Promise.withResolvers<string>()
  const owner = createWorkspaceRoots({
    active: preference(null),
    home: preference('/cached'),
    readHome: () => completion.promise,
    onHomeFailure: mock(),
  })
  expect(await owner.ready()).toBe('/cached')
  completion.resolve('/verified')
  await owner.start()
  expect(await owner.ready()).toBe('/verified')
})

test('verification failure is reported once and preserves the cached answer', async () => {
  const failure = new Error('platform unavailable')
  const report = mock()
  const owner = createWorkspaceRoots({
    active: preference(null),
    home: preference('/cached'),
    readHome: () => Promise.reject(failure),
    onHomeFailure: report,
  })
  expect(await owner.start()).toBe('/cached')
  await owner.start()
  expect(report).toHaveBeenCalledTimes(1)
  expect(report).toHaveBeenCalledWith(failure)
})

test('disposal suppresses late writes and publication', async () => {
  const completion = Promise.withResolvers<string>()
  const home = preference(null)
  const active = preference(null)
  const publish = mock()
  home.subscribe(publish)
  const owner = createWorkspaceRoots({
    active,
    home,
    readHome: () => completion.promise,
    onHomeFailure: mock(),
  })
  const pending = owner.start()
  await Promise.resolve()
  owner.dispose()
  completion.resolve('/late')
  await pending
  owner.setActive('/late')
  expect(home.read()).toBeNull()
  expect(active.read()).toBeNull()
  expect(publish).not.toHaveBeenCalled()
})
