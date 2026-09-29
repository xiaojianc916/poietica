import { describe, expect, test } from 'bun:test'
import type { ThreadPort, ThreadRecord } from '../../agent/thread'
import { ThreadsStore } from '../threads-store'

/*
 * 分享的动作面。菜单与提示在 surface 那一层，这里只钉住「动作把什么交给调用方」：
 * 链接必须原样出来，失败必须是 null 而不是一条编出来的链接。
 */

const at = '2026-01-01T00:00:00.000Z'

function record(): ThreadRecord {
  return {
    threadId: 'thread',
    sessionId: 'session',
    title: 'Original',
    titleSource: 'manual',
    updatedAt: at,
    pinned: false,
    workspaceRoot: '/workspace',
    archived: false,
  }
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

describe('share action', () => {
  test('hands the link back to the caller', async () => {
    const store = new ThreadsStore({
      port: port({
        share: async () => ({ url: 'https://my.omp.sh/s/abc#key', truncated: false }),
      }),
    })
    const shared = await store.share('thread')
    expect(shared).toEqual({ url: 'https://my.omp.sh/s/abc#key', truncated: false })
    expect(store.listSnapshot().failure).toBeNull()
    store.dispose()
  })

  test('a port that cannot share yields no link rather than a fake one', async () => {
    const store = new ThreadsStore({ port: port() })
    expect(await store.share('thread')).toBeNull()
    store.dispose()
  })

  test('a failed upload reports the reason and returns nothing', async () => {
    const store = new ThreadsStore({
      port: port({
        share: async () => {
          throw new Error('the upload was refused')
        },
      }),
    })
    expect(await store.share('thread')).toBeNull()
    expect(store.listSnapshot().failure).toContain('the upload was refused')
    store.dispose()
  })

  test('truncation travels with the link', async () => {
    const store = new ThreadsStore({
      port: port({ share: async () => ({ url: 'https://my.omp.sh/s/abc#key', truncated: true }) }),
    })
    expect(await store.share('thread')).toEqual({
      url: 'https://my.omp.sh/s/abc#key',
      truncated: true,
    })
    store.dispose()
  })

  test('a disposed store starts no upload', async () => {
    let calls = 0
    const store = new ThreadsStore({
      port: port({
        share: async () => {
          calls += 1
          return { url: 'https://my.omp.sh/s/abc#key', truncated: false }
        },
      }),
    })
    store.dispose()
    expect(await store.share('thread')).toBeNull()
    expect(calls).toBe(0)
  })
})
