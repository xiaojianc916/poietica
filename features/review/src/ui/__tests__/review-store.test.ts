import { describe, expect, test } from 'bun:test'
import type { DiffFile } from '@poietica/design-system/diff'
import { waitFor } from '@poietica/test-kit'
import type { GitStatus, ReviewFile } from '../../contract'
import { createReviewStore, type ReviewGateway, type ReviewStore } from '../review-store'

const STATUS: GitStatus = {
  ahead: 0,
  behind: 0,
  branch: 'main',
  detachedAt: null,
  isRepo: true,
  staged: [],
  unstaged: [],
  upstream: null,
}

interface Fixture {
  readonly gateway: ReviewGateway
  readonly patches: string[]
  file: ReviewFile
  patch: string
}

function fixture(): Fixture {
  const held: Fixture = {
    file: {
      additions: 300,
      binary: false,
      change: 'untracked',
      deletions: 0,
      oldPath: null,
      path: 'new.ts',
    },
    gateway: {
      commit: async () => ({}),
      filePatch: async (_base, path) => {
        held.patches.push(path)
        return held.patch
      },
      review: async () => ({
        branches: ['main'],
        changes: [held.file],
        staged: [],
        status: STATUS,
      }),
      watch: async () => async () => undefined,
      workspaceId: 'one',
    },
    patch: 'first',
    patches: [],
  }
  return held
}

function storeOf(gateway: ReviewGateway): ReviewStore {
  return createReviewStore({
    derive: async (patch): Promise<readonly DiffFile[]> => [
      {
        binary: false,
        path: 'new.ts',
        rows: [
          {
            at: 0,
            hidden: [],
            kind: 'added',
            lines: 0,
            number: 1,
            pieces: [{ at: 0, color: null, emphasis: false, text: patch }],
            text: patch,
          },
        ],
        stat: { added: 1, removed: 0 },
      },
    ],
    gateway,
    report: (code, { cause }) => {
      throw new Error(`${code}: ${String(cause)}`)
    },
  })
}

function ready(
  store: ReviewStore,
): Extract<ReturnType<ReviewStore['store']['getState']>['reading'], { phase: 'ready' }> {
  const reading = store.store.getState().reading
  if (reading.phase !== 'ready') throw new Error('清单还没有读好')
  return reading
}

describe('审查清单与按需补丁', () => {
  test('清单回到非零统计后不会继续复用旧零值，展开与折叠也不改数字', async () => {
    const held = fixture()
    held.file = { ...held.file, additions: 0 }
    const store = storeOf(held.gateway)
    const stop = store.start()
    try {
      await waitFor(() => store.store.getState().reading.phase === 'ready')
      expect(ready(store).stat).toEqual({ added: 0, removed: 0 })

      held.file = { ...held.file, additions: 300 }
      store.refresh()
      await waitFor(() => ready(store).stat.added === 300)

      store.openFile('new.ts')
      await waitFor(() => ready(store).files[0]?.rows.length === 1)
      expect(ready(store).files[0]?.stat).toEqual({ added: 300, removed: 0 })
      expect(ready(store).stat).toEqual({ added: 300, removed: 0 })

      store.toggleFile('new.ts')
      expect(ready(store).files[0]?.stat).toEqual({ added: 300, removed: 0 })
      await waitFor(() => ready(store).files[0]?.rows.length === 0)
    } finally {
      stop()
    }
  })

  test('清单刷新后已展开补丁重读一次；折叠保留缓存，不反复取补丁', async () => {
    const held = fixture()
    const store = storeOf(held.gateway)
    const stop = store.start()
    try {
      await waitFor(() => store.store.getState().reading.phase === 'ready')
      store.openFile('new.ts')
      await waitFor(() => ready(store).files[0]?.rows[0]?.text === 'first')
      expect(held.patches).toEqual(['new.ts'])

      store.toggleFile('new.ts')
      store.openFile('new.ts')
      expect(held.patches).toEqual(['new.ts'])

      held.patch = 'second'
      store.refresh()
      await waitFor(() => ready(store).files[0]?.rows[0]?.text === 'second')
      expect(held.patches).toEqual(['new.ts', 'new.ts'])
      expect(ready(store).files[0]?.stat).toEqual({ added: 300, removed: 0 })
    } finally {
      stop()
    }
  })

  test('只改草稿或筛选时不换清单对象：卡片靠这一条跳过重渲', async () => {
    const held = fixture()
    const store = storeOf(held.gateway)
    const stop = store.start()
    try {
      await waitFor(() => store.store.getState().reading.phase === 'ready')
      const before = ready(store).files
      store.setDraft('写到一半')
      store.setQuery('new')
      store.setSplitter('drag')
      expect(ready(store).files).toBe(before)
      expect(held.patches).toEqual([])
    } finally {
      stop()
    }
  })
})
