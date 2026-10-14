import { AppError } from '@poietica/foundation'
import type { FeatureStore } from '@poietica/ui-kernel'
import { createFeatureStore } from '@poietica/ui-kernel'
import type {
  GithubAvailability,
  GithubComment,
  GithubMergeMethod,
  GithubPullRequest,
  GithubRepository,
} from '../contract'

/*
 * 代码审查页的状态机。与同目录的 review-store 是两份东西：那一份是「侧栏改动面板」（工作树对 HEAD），
 * 这一份是「代码审查页」（远端 GitHub 上的 pull request）。两者的数据源、生命周期与失败语义都不同，
 * 所以不塞进同一个 store —— 面板开着时页面不必刷新，反过来也一样。
 *
 * 页面自身没有「第几页」这类持久状态：列表一次取回（仓库的 PR 数量是几十的量级），
 * 过滤与搜索都在内存里做，键盘上下移动才不会有进程往返。
 */

export type PrFilter = 'all' | 'prs' | 'issues'
export type PrTab = 'summary' | 'changes' | 'timeline'

export type PrListPhase = 'asking' | 'unavailable' | 'ready'

export type PrFactsPhase = 'idle' | 'loading' | 'ready' | 'missing' | 'unreadable'

export interface PrReading {
  readonly phase: PrListPhase
  readonly repository: GithubRepository | null
  readonly login: string | null
  readonly pulls: readonly GithubPullRequest[]
}

export interface PrFacts {
  readonly phase: PrFactsPhase
  readonly pull: GithubPullRequest | null
}

export interface PrComments {
  readonly phase: 'idle' | 'loading' | 'ready' | 'unreadable'
  readonly items: readonly GithubComment[]
}

export interface PrState {
  readonly reading: PrReading
  /** 顶层错误的一句中文（已译好）；没有错误时为 null。 */
  readonly trouble: string | null
  readonly filter: PrFilter
  readonly query: string
  readonly selected: number | null
  readonly facts: PrFacts
  readonly comments: PrComments
  readonly tab: PrTab
  readonly draft: string
  /** 有一次写操作（评论 / 请求评审 / 合并）在路上。 */
  readonly busy: boolean
}

export interface PrGateway {
  readonly availability: () => Promise<GithubAvailability>
  readonly pullRequests: () => Promise<{ repository: GithubRepository | null; pulls: readonly GithubPullRequest[] }>
  readonly pullRequest: (number: number) => Promise<GithubPullRequest>
  readonly comments: (number: number) => Promise<readonly GithubComment[]>
  readonly comment: (number: number, body: string) => Promise<GithubComment>
  readonly setDraft: (number: number, draft: boolean) => Promise<void>
  readonly merge: (number: number, method: GithubMergeMethod) => Promise<void>
}

export type PrFailureReport = (context: { readonly cause: unknown }) => void

export interface PrStore {
  readonly store: FeatureStore<PrState>
  readonly start: () => () => void
  readonly refresh: () => void
  readonly setFilter: (filter: PrFilter) => void
  readonly setQuery: (query: string) => void
  readonly select: (number: number | null) => void
  readonly setTab: (tab: PrTab) => void
  readonly setDraft: (value: string) => void
  readonly comment: () => void
  /** 草稿 / 可评审（与评论草稿 setDraft 不是一件事，故另起名字）。 */
  readonly setDraftState: (draft: boolean) => void
  readonly merge: (method: GithubMergeMethod) => void
}

export interface PrStoreOptions {
  readonly gateway: PrGateway
  readonly report: PrFailureReport
}

/** AppError 的 message 已经是给人看的；其余错误不把栈端到界面上。 */
function messageOf(cause: unknown): string {
  if (cause instanceof AppError) {
    return cause.message
  }
  return '读不到 GitHub 上的改动。'
}

const ASKING: PrState = {
  reading: { phase: 'asking', repository: null, login: null, pulls: [] },
  trouble: null,
  filter: 'all',
  query: '',
  selected: null,
  facts: { phase: 'idle', pull: null },
  comments: { phase: 'idle', items: [] },
  tab: 'summary',
  draft: '',
  busy: false,
}

export function createPrStore(options: PrStoreOptions): PrStore {
  const { gateway, report } = options
  const store = createFeatureStore<PrState>(() => ASKING)
  const read = (): PrState => store.getState()
  /* 每次重新列清单都换一代：旧代的异步回包不许再落到新状态上（Core 会重启，页面也会刷新）。 */
  let generation = 0
  let factsFor: number | null = null
  let stopWatch: (() => void) | null = null

  function publish(change: Partial<PrState>): void {
    const before = read()
    const next = { ...before, ...change }
    if (
      Object.keys(change).every((name) => {
        const key = name as keyof PrState
        return Object.is(before[key], next[key])
      })
    ) {
      return
    }
    store.setState(next)
  }

  async function list(): Promise<void> {
    generation += 1
    const mine = generation
    publish({ reading: { ...read().reading, phase: 'asking' }, trouble: null })
    try {
      const availability = await gateway.availability()
      if (mine !== generation) return
      if (!availability.available) {
        publish({
          reading: { phase: 'unavailable', repository: null, login: null, pulls: [] },
          trouble: availability.reason,
          facts: { phase: 'idle', pull: null },
          comments: { phase: 'idle', items: [] },
        })
        return
      }
      const page = await gateway.pullRequests()
      if (mine !== generation) return
      publish({
        reading: {
          phase: 'ready',
          repository: page.repository,
          login: availability.login,
          pulls: page.pulls,
        },
      })
    } catch (cause) {
      if (mine !== generation) return
      report({ cause })
      publish({
        reading: { phase: 'unavailable', repository: null, login: null, pulls: [] },
        trouble: messageOf(cause),
      })
    }
  }

  /* 打开某一条：详情与评论一起拉，任一失败都只降级这一条，不把列表打回加载态。 */
  async function open(number: number): Promise<void> {
    const mine = generation
    factsFor = number
    publish({
      selected: number,
      facts: { phase: 'loading', pull: null },
      comments: { phase: 'loading', items: [] },
      draft: '',
    })
    const [facts, comments] = await Promise.allSettled([gateway.pullRequest(number), gateway.comments(number)])
    if (mine !== generation || factsFor !== number) return
    if (facts.status === 'rejected') {
      report({ cause: facts.reason })
      const missing = facts.reason instanceof AppError && String(facts.reason.code).endsWith('pull_request_missing')
      publish({ facts: { phase: missing ? 'missing' : 'unreadable', pull: null } })
    } else {
      publish({ facts: { phase: 'ready', pull: facts.value } })
    }
    if (comments.status === 'rejected') {
      report({ cause: comments.reason })
      publish({ comments: { phase: 'unreadable', items: [] } })
    } else {
      publish({ comments: { phase: 'ready', items: comments.value } })
    }
  }

  /* 写操作完成后按「重新读一次」收尾：评论与检查项都可能在别处变了，不接受发出去的那份回包当真相。 */
  async function write(run: () => Promise<void>, number: number | null): Promise<void> {
    if (number === null || read().busy) {
      return
    }
    publish({ busy: true })
    try {
      await run()
    } catch (cause) {
      report({ cause })
    } finally {
      publish({ busy: false })
    }
    await Promise.allSettled([list(), number === null ? Promise.resolve() : open(number)])
  }

  function selectedOrNull(): number | null {
    return read().selected
  }

  return {
    store,
    start: () => {
      void list()
      return () => {
        generation += 1
        factsFor = null
        stopWatch?.()
        stopWatch = null
      }
    },
    refresh: () => {
      void list()
      const number = selectedOrNull()
      if (number !== null) {
        void open(number)
      }
    },
    setFilter: (filter) => {
      publish({ filter })
    },
    setQuery: (query) => {
      publish({ query })
    },
    select: (number) => {
      if (number === null) {
        factsFor = null
        publish({ selected: null, facts: { phase: 'idle', pull: null }, comments: { phase: 'idle', items: [] } })
        return
      }
      void open(number)
    },
    setTab: (tab) => {
      publish({ tab })
    },
    setDraft: (draft) => {
      publish({ draft })
    },
    comment: () => {
      const number = selectedOrNull()
      const body = read().draft.trim()
      if (number === null || body === '') {
        return
      }
      publish({ draft: '' })
      void write(async () => {
        await gateway.comment(number, body)
      }, number)
    },
    setDraftState: (draft) => {
      const number = selectedOrNull()
      if (number === null) {
        return
      }
      void write(() => gateway.setDraft(number, draft), number)
    },
    merge: (method) => {
      const number = selectedOrNull()
      void write(() => gateway.merge(number ?? 0, method), number)
    },
  }
}

/** 过滤 + 搜索后的条目：列表栏拿它渲染，计数拿它数。 */
export function visiblePulls(
  pulls: readonly GithubPullRequest[],
  filter: PrFilter,
  query: string,
): readonly GithubPullRequest[] {
  const needle = query.trim().toLowerCase()
  return pulls.filter((pull) => {
    if (filter === 'prs' && pull.state === 'closed') return false
    if (filter === 'issues') return false
    if (needle === '') return true
    return pull.title.toLowerCase().includes(needle) || `#${String(pull.number)}`.includes(needle)
  })
}

export function filterCounts(pulls: readonly GithubPullRequest[]): {
  readonly all: number
  readonly prs: number
  readonly issues: number
} {
  return { all: pulls.length, prs: pulls.length, issues: 0 }
}
