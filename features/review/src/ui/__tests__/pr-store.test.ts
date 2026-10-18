import { describe, expect, test } from 'bun:test'
import type { GithubComment, GithubPullRequest } from '../../contract'
import {
  checksSummaryLabel,
  checkTone,
  mergeStatusLabel,
  mergeStatusTone,
  pullMetaLine,
  pullStatePresentation,
  relativeTime,
  relativeTimeAgo,
  sortChecks,
} from '../pr-format'
import { createPrStore, FRESH_MS, filterCounts, type PrGateway, visiblePulls } from '../pr-store'

/* 纯函数与状态机的行为契约。UI 三块各自渲染，但它们对「多久以前」「什么颜色」「哪几条可见」的判断
 * 都从这里来，所以这一份测试守的是三块共同的口径。 */

const NOW = Date.parse('2026-10-14T12:00:00Z')

function pull(over: Partial<GithubPullRequest> = {}): GithubPullRequest {
  return {
    number: 3,
    title: 'refactor(plugins): give installed ledger one native owner',
    state: 'open',
    draft: false,
    author: 'xiaojianc916',
    avatarUrl: null,
    createdAt: '2026-09-08T16:07:58Z',
    updatedAt: '2026-09-08T16:07:58Z',
    mergedAt: null,
    headBranch: 'refactor/plugin-ledger-ownership',
    baseBranch: 'main',
    additions: 553,
    deletions: 358,
    changedFiles: 6,
    commits: 4,
    comments: 0,
    reviews: 0,
    mergeStatus: 'conflicting',
    reviewState: 'none',
    url: 'https://github.com/xiaojianc916/poietica/pull/3',
    body: '',
    labels: [],
    checks: [],
    ...over,
  }
}

describe('相对时间', () => {
  test('按 GitHub 的档位向下取整', () => {
    expect(relativeTime(new Date(NOW - 10_000).toISOString(), NOW)).toBe('now')
    expect(relativeTime(new Date(NOW - 5 * 60_000).toISOString(), NOW)).toBe('5m')
    expect(relativeTime(new Date(NOW - 3 * 3_600_000).toISOString(), NOW)).toBe('3h')
    expect(relativeTime(new Date(NOW - 2 * 86_400_000).toISOString(), NOW)).toBe('2d')
    expect(relativeTime(new Date(NOW - 10 * 86_400_000).toISOString(), NOW)).toBe('1w')
    expect(relativeTime(new Date(NOW - 40 * 86_400_000).toISOString(), NOW)).toBe('1mo')
    expect(relativeTime(new Date(NOW - 400 * 86_400_000).toISOString(), NOW)).toBe('1y')
  })

  test('详情头写 ago，刚好是刚才写 just now', () => {
    expect(relativeTimeAgo(new Date(NOW - 10_000).toISOString(), NOW)).toBe('just now')
    expect(relativeTimeAgo(new Date(NOW - 40 * 86_400_000).toISOString(), NOW)).toBe('1mo ago')
  })

  test('读不出来的时间给空串，不写 NaN', () => {
    expect(relativeTime('不是时间', NOW)).toBe('')
    expect(relativeTimeAgo('', NOW)).toBe('')
  })
})

describe('状态呈现', () => {
  test('草稿优先于开着', () => {
    expect(pullStatePresentation(pull({ draft: true })).label).toBe('Draft')
  })

  /*
   * 冲突改状态词：开着又有冲突时，「有冲突」才是人此刻要知道的那件事（参考实现也是这么排的）。
   * 草稿仍然优先 —— 草稿不急着合，先照实说它是草稿。
   */
  test('开着又有冲突时说「有冲突」', () => {
    expect(pullStatePresentation(pull({ mergeStatus: 'conflicting' })).label).toBe('Has conflicts')
  })

  test('草稿优先于冲突', () => {
    expect(pullStatePresentation(pull({ draft: true, mergeStatus: 'conflicting' })).label).toBe('Draft')
  })

  test('被拦 / 落后不改状态词（它们归 Merge status 那张卡）', () => {
    expect(pullStatePresentation(pull({ mergeStatus: 'blocked' })).label).toBe('Open')
    expect(pullStatePresentation(pull({ mergeStatus: 'behind' })).label).toBe('Open')
  })

  test('合并与关闭各有自己的词', () => {
    expect(pullStatePresentation(pull({ state: 'merged' })).label).toBe('Merged')
    expect(pullStatePresentation(pull({ state: 'closed' })).label).toBe('Closed')
  })

  test('截图里那句冲突文案就是它', () => {
    expect(mergeStatusLabel('conflicting')).toBe('Conflicts with main')
    expect(mergeStatusTone('conflicting')).toBe('bad')
    expect(mergeStatusTone('clean')).toBe('ok')
  })

  test('检查项：失败红、进行中黄、其余灰', () => {
    expect(checkTone('failure')).toBe('bad')
    expect(checkTone('pending')).toBe('warn')
    expect(checkTone('skipped')).toBe('muted')
  })

  test('整份检查的结论说实话', () => {
    expect(checksSummaryLabel([])).toBe('No checks')
    expect(checksSummaryLabel([{ name: 'Rust', state: 'failure' }])).toBe('1 failing')
    expect(checksSummaryLabel([{ name: 'Rust', state: 'pending' }])).toBe('Checks running')
    expect(checksSummaryLabel([{ name: 'Frontend', state: 'success' }])).toBe('All checks passed')
  })

  test('失败的检查排最前', () => {
    const sorted = sortChecks([
      { name: 'Frontend', state: 'success' },
      { name: 'Rust', state: 'failure' },
      { name: 'Windows Desktop', state: 'pending' },
    ])
    expect(sorted.map((c) => c.name)).toEqual(['Rust', 'Windows Desktop', 'Frontend'])
  })

  test('列表 meta 行是「作者 · 时间 · 仓库 #号」', () => {
    expect(pullMetaLine(pull(), 'poietica')).toBe('xiaojianc916 · 1mo ago · poietica #3')
  })
})

describe('列表过滤', () => {
  test('标题与编号都能搜到，大小写不敏感', () => {
    const pulls = [pull(), pull({ number: 2, title: 'refactor(composer): unify MCP' })]
    expect(visiblePulls(pulls, 'all', 'mcp').map((p) => p.number)).toEqual([2])
    expect(visiblePulls(pulls, 'all', '#3').map((p) => p.number)).toEqual([3])
  })

  test('计数与截图一致：两个 PR、零个 issue', () => {
    expect(filterCounts([pull(), pull({ number: 2 })])).toEqual({ all: 2, prs: 2, issues: 0 })
  })
})

describe('代码审查页的状态机', () => {
  function gateway(over: Partial<PrGateway> = {}): PrGateway {
    return {
      availability: async () => ({ available: true, reason: null, login: 'xiaojianc916' }),
      pullRequests: async () => ({
        repository: { owner: 'a', name: 'b', fullName: 'a/b', url: 'https://x' },
        pulls: [pull()],
      }),
      pullRequest: async () => pull(),
      comments: async () => [],
      comment: async (): Promise<GithubComment> => ({
        id: '1',
        kind: 'comment',
        author: 'a',
        avatarUrl: null,
        body: 'x',
        createdAt: new Date(NOW).toISOString(),
        reviewState: null,
      }),
      setDraft: async () => undefined,
      merge: async () => undefined,
      ...over,
    }
  }

  const settle = async (): Promise<void> => {
    await new Promise((resolve) => setTimeout(resolve, 0))
    await new Promise((resolve) => setTimeout(resolve, 0))
  }

  test('读完之后进入 ready，列表在这一份 store 里', async () => {
    const store = createPrStore({ gateway: gateway(), report: () => undefined })
    store.start()
    await settle()
    const state = store.store.getState()
    expect(state.reading.phase).toBe('ready')
    expect(state.reading.pulls.map((p) => p.number)).toEqual([3])
  })

  test('GitHub 不可用只说一句为什么，列表进 unavailable', async () => {
    const store = createPrStore({
      gateway: gateway({ availability: async () => ({ available: false, reason: '没登录', login: null }) }),
      report: () => undefined,
    })
    store.start()
    await settle()
    expect(store.store.getState().reading.phase).toBe('unavailable')
    expect(store.store.getState().trouble).toBe('没登录')
  })

  test('选中一条就把详情与评论一起拉回来', async () => {
    const store = createPrStore({ gateway: gateway(), report: () => undefined })
    store.start()
    await settle()
    store.select(3)
    await settle()
    const state = store.store.getState()
    expect(state.facts.phase).toBe('ready')
    expect(state.facts.pull?.number).toBe(3)
    expect(state.comments.phase).toBe('ready')
  })

  test('状态胶囊切换草稿：走的是 setDraft，且切换后重新读一次', async () => {
    const seen: boolean[] = []
    const store = createPrStore({
      gateway: gateway({
        setDraft: async (_number, draft) => {
          seen.push(draft)
        },
      }),
      report: () => undefined,
    })
    store.start()
    await settle()
    store.select(3)
    await settle()
    store.setDraftState(true)
    await settle()
    store.setDraftState(false)
    await settle()
    expect(seen).toEqual([true, false])
  })

  test('空白评论不会发出去', async () => {
    let sent = 0
    const store = createPrStore({
      gateway: gateway({
        comment: async (): Promise<GithubComment> => {
          sent += 1
          throw new Error('不该走到这里')
        },
      }),
      report: () => undefined,
    })
    store.start()
    await settle()
    store.select(3)
    await settle()
    store.setDraft('   ')
    store.comment()
    await settle()
    expect(sent).toBe(0)
  })

  describe('缓存：离开页面再回来', () => {
    function counting(over: Partial<PrGateway> = {}) {
      const calls = { list: 0, pull: 0, comments: 0 }
      const base = gateway(over)
      const counted: PrGateway = {
        ...base,
        pullRequests: () => {
          calls.list += 1
          return base.pullRequests()
        },
        pullRequest: (number) => {
          calls.pull += 1
          return base.pullRequest(number)
        },
        comments: (number) => {
          calls.comments += 1
          return base.comments(number)
        },
      }
      return { calls, gateway: counted }
    }

    test('新鲜期内回来：不重读，状态原样（选中项、标签页都还在）', async () => {
      let clock = NOW
      const { calls, gateway: g } = counting()
      const store = createPrStore({ gateway: g, report: () => undefined, now: () => clock })
      let stop = store.start()
      await settle()
      store.select(3)
      store.setTab('timeline')
      await settle()
      stop()

      clock += FRESH_MS - 1
      stop = store.start()
      const state = store.store.getState()
      expect(state.reading.phase).toBe('ready')
      expect(state.selected).toBe(3)
      expect(state.tab).toBe('timeline')
      await settle()
      expect(calls).toEqual({ list: 1, pull: 0, comments: 1 })
      stop()
    })

    test('过期了回来：先画旧的，背后重读，读回来再换上', async () => {
      let clock = NOW
      let title = '旧标题'
      const { calls, gateway: g } = counting({
        pullRequests: async () => ({
          repository: { owner: 'a', name: 'b', fullName: 'a/b', url: 'https://x' },
          pulls: [pull({ title })],
        }),
      })
      const store = createPrStore({ gateway: g, report: () => undefined, now: () => clock })
      const stop = store.start()
      await settle()
      stop()

      clock += FRESH_MS
      title = '新标题'
      store.start()
      /* 重读还在路上：屏幕上照旧是旧清单，不是加载态 */
      expect(store.store.getState().reading.phase).toBe('ready')
      expect(store.store.getState().refreshing).toBe(true)
      expect(store.store.getState().reading.pulls[0]?.title).toBe('旧标题')
      await settle()
      expect(store.store.getState().refreshing).toBe(false)
      expect(store.store.getState().reading.pulls[0]?.title).toBe('新标题')
      expect(calls.list).toBe(2)
    })

    test('背后重读失败：手上那份不打掉', async () => {
      let clock = NOW
      let broken = false
      const store = createPrStore({
        gateway: gateway({
          pullRequests: async () => {
            if (broken) throw new Error('offline')
            return { repository: { owner: 'a', name: 'b', fullName: 'a/b', url: 'https://x' }, pulls: [pull()] }
          },
        }),
        report: () => undefined,
        now: () => clock,
      })
      store.start()
      await settle()
      broken = true
      clock += FRESH_MS
      store.refresh()
      await settle()
      expect(store.store.getState().reading.phase).toBe('ready')
      expect(store.store.getState().reading.pulls).toHaveLength(1)
    })

    test('点开一条：列表里的字段先画上，只补读评论；再点回来是即时的', async () => {
      const { calls, gateway: g } = counting()
      const store = createPrStore({ gateway: g, report: () => undefined, now: () => NOW })
      store.start()
      await settle()
      store.select(3)
      expect(store.store.getState().facts.phase).toBe('ready')
      await settle()
      expect(calls.pull).toBe(0)
      expect(calls.comments).toBe(1)

      store.select(null)
      store.select(3)
      expect(store.store.getState().comments.phase).toBe('ready')
      await settle()
      expect(calls.comments).toBe(1)
    })
  })
})
