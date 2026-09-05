import { describe, expect, test } from 'bun:test'
import type { ThreadPort, ThreadRecord } from '../../agent'
import { nameOf, shorten } from '../thread-title'
import { ThreadsStore } from '../threads-store'

const at = '2026-01-01T00:00:00.000Z'
function record(title = 'Original'): ThreadRecord {
  return {
    threadId: 'thread',
    sessionId: 'session',
    title,
    titleSource: 'manual',
    updatedAt: at,
    pinned: false,
    workspaceRoot: '/workspace',
    archived: false,
  }
}
function gate(): { wait: Promise<void>; release: () => void } {
  let release = (): void => {}
  const wait = new Promise<void>((resolve) => {
    release = resolve
  })
  return { wait, release }
}
function port(overrides: Partial<ThreadPort> = {}): ThreadPort {
  return {
    list: async () => [record()],
    read: async () => ({ thread: record() }),
    create: async () => {
      throw new Error('creation is not part of this fixture')
    },
    open: async () => {
      throw new Error('activation is not part of this fixture')
    },
    ...overrides,
  }
}

describe('conversation index ownership', () => {
  test('an older list response cannot resurrect a deleted conversation', async () => {
    const entered = gate()
    const release = gate()
    let exists = true
    let reads = 0
    const store = new ThreadsStore({
      port: port({
        list: async () => {
          reads += 1
          if (reads === 1) {
            entered.release()
            await release.wait
            return [record()]
          }
          return exists ? [record()] : []
        },
        remove: async () => {
          exists = false
        },
      }),
    })
    const refreshing = store.refresh()
    await entered.wait
    await store.remove('thread')
    release.release()
    await refreshing
    expect(store.listSnapshot().items).toEqual([])
    expect(store.listSnapshot().isLoading).toBe(false)
    store.dispose()
  })
  test('rename commands are ordered and use the authoritative normalized response', async () => {
    const entered = gate()
    const release = gate()
    const calls: string[] = []
    let saved = record()
    const store = new ThreadsStore({
      port: port({
        list: async () => [saved],
        read: async () => ({ thread: saved }),
        rename: async (_, title) => {
          calls.push(title)
          if (title === 'first') {
            entered.release()
            await release.wait
          }
          saved = { ...saved, title: title.toUpperCase() }
        },
      }),
    })
    await store.refresh()
    const first = store.rename('thread', 'first')
    await entered.wait
    const second = store.rename('thread', 'second')
    expect(calls).toEqual(['first'])
    expect(store.titleOf('thread')).toBe('second')
    release.release()
    await Promise.all([first, second])
    expect(calls).toEqual(['first', 'second'])
    expect(store.titleOf('thread')).toBe('SECOND')
    store.dispose()
  })
  test('a failed command cannot overwrite a later optimistic intent', async () => {
    const entered = gate()
    const release = gate()
    let saved = record()
    const store = new ThreadsStore({
      port: port({
        list: async () => [saved],
        read: async () => ({ thread: saved }),
        rename: async (_, title) => {
          if (title === 'first') {
            entered.release()
            await release.wait
            throw new Error('refused')
          }
          saved = { ...saved, title }
        },
      }),
    })
    await store.refresh()
    const first = store.rename('thread', 'first')
    await entered.wait
    const second = store.rename('thread', 'second')
    release.release()
    await Promise.all([first, second])
    expect(store.titleOf('thread')).toBe('second')
    expect(store.listSnapshot().failure).toBeNull()
    store.dispose()
  })
  test('disposal prevents queued writes and late removal notifications', async () => {
    const entered = gate()
    const release = gate()
    const calls: string[] = []
    let removals = 0
    const store = new ThreadsStore({
      port: port({
        remove: async () => {
          calls.push('remove')
          entered.release()
          await release.wait
        },
        rename: async () => {
          calls.push('rename')
        },
      }),
    })
    store.onRemoved(() => {
      removals += 1
    })
    await store.refresh()
    const removing = store.remove('thread')
    await entered.wait
    const renaming = store.rename('thread', 'later')
    store.dispose()
    release.release()
    await Promise.all([removing, renaming])
    expect(calls).toEqual(['remove'])
    expect(removals).toBe(0)
  })
  test('a confirmed generated title replaces a provisional title and stale title intent', async () => {
    let found: readonly ThreadRecord[] = []
    const store = new ThreadsStore({ now: () => at, port: port({ list: async () => found }) })
    store.noteUserMessage('thread', 'opening')
    expect(store.titleOf('thread')).toBe('opening')
    found = [
      { ...record('Generated'), titleSource: 'generated', updatedAt: '2026-01-01T00:00:01.000Z' },
    ]
    await store.refresh()
    expect(store.titleOf('thread')).toBe('Generated')
    found = []
    await store.refresh()
    expect(store.listSnapshot().items).toEqual([])
    store.dispose()
  })
  test('unchanged projections keep the published snapshot reference', async () => {
    const store = new ThreadsStore({ port: port() })
    await store.refresh()
    const snapshot = store.listSnapshot()
    await store.refresh()
    expect(store.listSnapshot()).toBe(snapshot)
    expect(store.rootOf('thread')).toBe('/workspace')
    store.dispose()
  })
})

test('title clipping uses complete Unicode graphemes and honors generated titles', () => {
  const cluster = '👨‍👩‍👧‍👦'
  expect(shorten(cluster.repeat(49))).toBe(`${cluster.repeat(48)}…`)
  expect(shorten('e\u0301'.repeat(49))).toBe(`${'e\u0301'.repeat(48)}…`)
  expect(nameOf({ ...record('Generated'), titleSource: 'generated' })).toBe('Generated')
})
