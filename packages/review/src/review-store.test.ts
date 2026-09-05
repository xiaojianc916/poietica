import { describe, expect, test } from 'bun:test'
import type { GitReview } from '@poietica/contract/review'
import type { ReviewGateway } from './review-gateway'
import { createReviewStore, type ReviewDerive } from './review-store'
import { parseUnifiedPatch } from './unified-diff'

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (cause: unknown) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0))
const PATCH = [
  'diff --git a/file.txt b/file.txt',
  '--- a/file.txt',
  '+++ b/file.txt',
  '@@ -1 +1 @@',
  '-before',
  '+after',
  '',
].join('\n')

function answer(branch = 'main'): GitReview {
  return {
    branch,
    detachedAt: null,
    upstream: null,
    ahead: 0,
    behind: 0,
    branches: ['main', 'topic'],
    changes: [{ path: 'file.txt', status: 'modified', staged: false }],
    patch: PATCH,
  }
}
function fixture(
  overrides: Partial<ReviewGateway> = {},
  derive: ReviewDerive = async (patch, wordDiff) => parseUnifiedPatch(patch, wordDiff),
) {
  const failures: unknown[] = []
  const watchers: Array<() => void> = []
  let released = 0
  let reads = 0
  const gateway: ReviewGateway = {
    review: () => {
      reads += 1
      return Promise.resolve(answer())
    },
    filePatch: () => Promise.resolve(PATCH),
    watch: (_root, changed) => {
      watchers.push(changed)
      return Promise.resolve(() => {
        released += 1
        return Promise.resolve()
      })
    },
    commit: () => Promise.resolve(answer()),
    ...overrides,
  }
  const store = createReviewStore({
    root: '/repository',
    gateway,
    derive,
    report: (_code, context) => {
      failures.push(context.cause)
    },
  })
  return { store, failures, watchers, reads: () => reads, released: () => released }
}

describe('review observation ownership', () => {
  test('a late subscription is released rather than attached to a restarted observation', async () => {
    const late = deferred<() => Promise<void>>()
    let subscriptions = 0
    let lateReleased = 0
    const f = fixture({
      watch: () => {
        subscriptions += 1
        return subscriptions === 1 ? late.promise : Promise.resolve(async () => {})
      },
    })
    const stop = f.store.start()
    stop()
    const stopAgain = f.store.start()
    late.resolve(() => {
      lateReleased += 1
      return Promise.resolve()
    })
    await flush()
    expect(lateReleased).toBe(1)
    stop()
    expect(() => f.store.start()).toThrow('already started')
    stopAgain()
  })
  test('callbacks and reads owned by a stopped observation cannot publish', async () => {
    const late = deferred<GitReview | null>()
    const f = fixture({ review: () => late.promise })
    const stop = f.store.start()
    await flush()
    stop()
    const held = f.store.getSnapshot()
    late.resolve(answer('obsolete'))
    f.watchers[0]?.()
    await flush()
    expect(f.store.getSnapshot()).toBe(held)
    expect(f.released()).toBe(1)
  })
  test('a failed subscription still permits the initial authoritative read', async () => {
    const f = fixture({
      watch: () => Promise.reject(new Error('watch unavailable')),
    })
    const stop = f.store.start()
    await flush()
    expect(f.store.getSnapshot().reading.phase).toBe('ready')
    expect(f.failures).toHaveLength(1)
    stop()
  })
  test('a late result cannot paint the wrong comparison base', async () => {
    const first = deferred<GitReview | null>()
    let calls = 0
    const f = fixture({
      review: (_root, base) => {
        calls += 1
        return calls === 1 ? first.promise : Promise.resolve(answer(base))
      },
    })
    const stop = f.store.start()
    f.store.setBase('topic')
    expect(f.store.getSnapshot().reading.phase).toBe('asking')
    first.resolve(answer('obsolete'))
    await flush()
    const reading = f.store.getSnapshot().reading
    expect(reading.phase).toBe('ready')
    if (reading.phase === 'ready') {
      expect(reading.head).toBe('topic')
    }
    stop()
  })
  test('unchanged presentation setters retain the cached snapshot', () => {
    const f = fixture()
    const held = f.store.getSnapshot()
    f.store.setQuery('')
    f.store.setTreeWidth(240)
    expect(f.store.getSnapshot()).toBe(held)
  })
})

describe('review derivation ownership', () => {
  test('an enriched file is cached by the authoritative listing rather than its expanded rows', async () => {
    const whole = PATCH.replace('@@ -1 +1 @@', '@@ -1,2 +1,2 @@\n heading')
    let requests = 0
    const f = fixture({
      filePatch: () => {
        requests += 1
        return Promise.resolve(whole)
      },
    })
    const stop = f.store.start()
    await flush()
    f.store.openFile('file.txt')
    await flush()
    expect(requests).toBe(1)
    f.store.refresh()
    await flush()
    expect(requests).toBe(1)
    expect(f.failures).toEqual([])
    stop()
  })
  test('presentation changes invalidate a pending file request before dispatching derivation', async () => {
    const pending = deferred<string>()
    let requests = 0
    const modes: boolean[] = []
    const f = fixture(
      {
        filePatch: () => {
          requests += 1
          return requests === 1 ? pending.promise : Promise.resolve(PATCH)
        },
      },
      (patch, wordDiff) => {
        modes.push(wordDiff)
        return Promise.resolve(parseUnifiedPatch(patch, wordDiff))
      },
    )
    const stop = f.store.start()
    await flush()
    f.store.openFile('file.txt')
    f.store.toggleSwitch('wordDiff')
    pending.resolve(PATCH)
    await flush()
    expect(modes).toEqual([false])
    expect(f.store.getSnapshot().presentation.wordDiff).toBe(false)
    stop()
  })
  test('a base change never publishes a snapshot labelled with the wrong base', async () => {
    const f = fixture()
    const stop = f.store.start()
    await flush()
    const observed: string[] = []
    const release = f.store.subscribe(() => {
      const state = f.store.getSnapshot()
      observed.push(`${state.base}:${state.reading.phase}`)
    })
    f.store.setBase('topic')
    expect(observed).toEqual(['topic:asking'])
    release()
    stop()
  })
})

describe('review mutation ownership', () => {
  test('a completed commit never consumes edits made while it was running', async () => {
    const completed = deferred<GitReview>()
    const f = fixture({ commit: () => completed.promise })
    const stop = f.store.start()
    await flush()
    f.store.setDraft('submitted')
    f.store.commit('commit')
    f.store.setDraft('next commit')
    const reads = f.reads()
    completed.resolve(answer('stale command projection'))
    await flush()
    expect(f.store.getSnapshot().draft).toBe('next commit')
    expect(f.store.getSnapshot().busy).toBe(false)
    expect(f.reads()).toBeGreaterThan(reads)
    const reading = f.store.getSnapshot().reading
    if (reading.phase === 'ready') {
      expect(reading.head).toBe('main')
    }
    stop()
  })
  test('a successful commit consumes only the unchanged submitted draft', async () => {
    const f = fixture()
    const stop = f.store.start()
    await flush()
    f.store.setDraft('submitted')
    f.store.commit('commit')
    await flush()
    expect(f.store.getSnapshot().draft).toBe('')
    stop()
  })
  test('a failed or partially successful operation preserves the draft and re-reads Git', async () => {
    const f = fixture({
      commit: () => Promise.reject(new Error('push failed')),
    })
    const stop = f.store.start()
    await flush()
    const reads = f.reads()
    f.store.setDraft('keep this')
    f.store.commit('commit-and-push')
    await flush()
    expect(f.store.getSnapshot().draft).toBe('keep this')
    expect(f.store.getSnapshot().busy).toBe(false)
    expect(f.reads()).toBeGreaterThan(reads)
    expect(f.failures).toHaveLength(1)
    stop()
  })
  test('concurrent commit requests share one in-flight write', async () => {
    const completed = deferred<GitReview>()
    let writes = 0
    const f = fixture({
      commit: () => {
        writes += 1
        return completed.promise
      },
    })
    const stop = f.store.start()
    await flush()
    f.store.commit('commit')
    f.store.commit('commit-and-push')
    await flush()
    expect(writes).toBe(1)
    completed.resolve(answer())
    await flush()
    stop()
  })
})
