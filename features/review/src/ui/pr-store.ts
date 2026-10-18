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
 *
 * 缓存：store 按工作区常驻（见 pr-store-holder），离开页面再回来，屏幕上直接是上次读到的东西，
 * 不再整页回到「加载中」。回来时数据若已过了 FRESH_MS，就在背后安静地重读一遍（stale-while-revalidate），
 * 读回来再换上；读失败也不把手上那份打掉。打开一条 PR 时：列表里已经有它的全部字段，先拿来画，
 * 只补读评论；读过的评论按编号记着，再点回来是即时的。
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
  /** 手上已有数据，正在背后重读（不遮挡界面，只让刷新按钮转起来）。 */
  readonly refreshing: boolean
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
  /** 测试注入；默认 Date.now。 */
  readonly now?: () => number
}

/* 这么久之内读过的就当新鲜：来回切页面不重读；过了才在背后重读。手动刷新与写操作之后不看它。 */
export const FRESH_MS = 60_000

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
  refreshing: false,
}

export function createPrStore(options: PrStoreOptions): PrStore {
  const { gateway, report } = options
  const now = options.now ?? Date.now
  const store = createFeatureStore<PrState>(() => ASKING)
  const read = (): PrState => store.getState()
  /* 每次重新列清单都换一代：旧代的异步回包不许再落到新状态上（Core 会重启，页面也会刷新）。 */
  let generation = 0
  let factsFor: number | null = null
  let stopWatch: (() => void) | null = null
  /* 上次列表读成功的时刻；0 表示还没读成过。 */
  let listedAt = 0
  /* 每条 PR 读回来的详情与评论（按编号），连同读到的时刻：再点回来先画它。 */
  const opened = new Map<
    number,
    { pull: GithubPullRequest | null; comments: readonly GithubComment[] | null; at: number }
  >()

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

  function markUnavailable(reason: string | null): void {
    publish({
      reading: { phase: 'unavailable', repository: null, login: null, pulls: [] },
      trouble: reason,
      facts: { phase: 'idle', pull: null },
      comments: { phase: 'idle', items: [] },
      refreshing: false,
    })
  }

  function applyPage(
    login: string | null,
    page: { repository: GithubRepository | null; pulls: readonly GithubPullRequest[] },
  ): void {
    listedAt = now()
    publish({
      reading: { phase: 'ready', repository: page.repository, login, pulls: page.pulls },
      trouble: null,
      refreshing: false,
    })
    /* 选中的那条若在新清单里，详情跟着换成新读到的（同一套字段） */
    const selected = read().selected
    const fresh = selected === null ? undefined : page.pulls.find((pull) => pull.number === selected)
    if (fresh !== undefined && read().facts.phase === 'ready') {
      publish({ facts: { phase: 'ready', pull: fresh } })
    }
  }

  function listFailed(cause: unknown, quiet: boolean): void {
    report({ cause })
    if (quiet) {
      /* 背后重读失败：手上那份照旧画着，只提示一次。 */
      publish({ refreshing: false })
      return
    }
    publish({
      reading: { phase: 'unavailable', repository: null, login: null, pulls: [] },
      trouble: messageOf(cause),
      refreshing: false,
    })
  }

  async function list(): Promise<void> {
    generation += 1
    const mine = generation
    /* 手上已有清单：背后重读，不把列表打回加载态。 */
    const quiet = read().reading.phase === 'ready'
    publish(quiet ? { refreshing: true } : { reading: { ...read().reading, phase: 'asking' }, trouble: null })
    try {
      const availability = await gateway.availability()
      if (mine !== generation) return
      if (!availability.available) {
        markUnavailable(availability.reason)
        return
      }
      const page = await gateway.pullRequests()
      if (mine === generation) applyPage(availability.login, page)
    } catch (cause) {
      if (mine === generation) listFailed(cause, quiet)
    }
  }

  type Entry = { pull: GithubPullRequest | null; comments: readonly GithubComment[] | null; at: number }

  /* 打开时手上已有的：读过的详情 / 评论，或者列表里它那一行（列表与详情是同一套字段）。 */
  function seedOf(number: number): {
    readonly memo: Entry | undefined
    readonly listed: GithubPullRequest | null
    readonly pull: GithubPullRequest | null
    readonly comments: readonly GithubComment[] | null
  } {
    const memo = opened.get(number)
    const listed = read().reading.pulls.find((pull) => pull.number === number) ?? null
    return { memo, listed, pull: memo?.pull ?? listed, comments: memo?.comments ?? null }
  }

  /* 要补读哪几样：force 两样都读；否则列表新鲜时详情不重读，评论读过且新鲜也不重读。 */
  function needsOf(seed: ReturnType<typeof seedOf>, force: boolean): { pull: boolean; comments: boolean } {
    if (force) return { pull: true, comments: true }
    const stale = seed.memo === undefined || now() - seed.memo.at >= FRESH_MS
    const listStale = seed.listed === null || now() - listedAt >= FRESH_MS
    return {
      pull: seed.pull === null || (stale && listStale),
      comments: seed.comments === null || stale,
    }
  }

  function applyFacts(
    number: number,
    result: PromiseSettledResult<GithubPullRequest>,
    seedPull: GithubPullRequest | null,
    entry: Entry,
  ): void {
    if (result.status === 'fulfilled') {
      entry.pull = result.value
      publish({ facts: { phase: 'ready', pull: result.value } })
      return
    }
    report({ cause: result.reason })
    const missing = result.reason instanceof AppError && String(result.reason.code).endsWith('pull_request_missing')
    if (missing) {
      opened.delete(number)
      publish({ facts: { phase: 'missing', pull: null } })
    } else if (seedPull === null) {
      publish({ facts: { phase: 'unreadable', pull: null } })
    }
  }

  function applyComments(
    result: PromiseSettledResult<readonly GithubComment[]>,
    seedComments: readonly GithubComment[] | null,
    entry: Entry,
  ): void {
    if (result.status === 'fulfilled') {
      entry.comments = result.value
      publish({ comments: { phase: 'ready', items: result.value } })
      return
    }
    report({ cause: result.reason })
    if (seedComments === null) {
      publish({ comments: { phase: 'unreadable', items: [] } })
    }
  }

  function showSeed(number: number, seed: ReturnType<typeof seedOf>, switching: boolean): void {
    publish({
      selected: number,
      facts: seed.pull === null ? { phase: 'loading', pull: null } : { phase: 'ready', pull: seed.pull },
      comments: seed.comments === null ? { phase: 'loading', items: [] } : { phase: 'ready', items: seed.comments },
      ...(switching ? { draft: '' } : {}),
    })
  }

  /* 两样都读成才记下时刻：只读成一半的，下次回来还要补。读成「查无此条」的不记。 */
  function remember(number: number, entry: Entry, complete: boolean): void {
    if (complete) {
      entry.at = now()
    }
    if (read().facts.phase !== 'missing') {
      opened.set(number, entry)
    }
  }

  /*
   * 打开某一条。先画手上有的，所以点下去是即时的；再补读缺的或过期的（见 needsOf）。
   * 补读失败只在「手上什么都没有」时才降级成读不出来，已经画着的不打掉。
   */
  async function open(number: number, force = false): Promise<void> {
    const mine = generation
    const switching = factsFor !== number || read().selected !== number
    factsFor = number
    const seed = seedOf(number)
    showSeed(number, seed, switching)
    const need = needsOf(seed, force)
    if (!need.pull && !need.comments) {
      return
    }
    const [facts, comments] = await Promise.allSettled([
      need.pull || seed.pull === null ? gateway.pullRequest(number) : Promise.resolve(seed.pull),
      need.comments ? gateway.comments(number) : Promise.resolve(seed.comments ?? []),
    ])
    if (mine !== generation || factsFor !== number) return
    const entry = opened.get(number) ?? { pull: null, comments: null, at: 0 }
    applyFacts(number, facts, seed.pull, entry)
    applyComments(comments, seed.comments, entry)
    remember(number, entry, facts.status === 'fulfilled' && comments.status === 'fulfilled')
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
    await Promise.allSettled([list(), number === null ? Promise.resolve() : open(number, true)])
  }

  function selectedOrNull(): number | null {
    return read().selected
  }

  return {
    store,
    start: () => {
      /* 回到页面：没读成过就读；读成过但过了新鲜期就背后重读；还新鲜就什么都不做（屏幕上已经是它）。 */
      const reading = read().reading
      if (reading.phase !== 'ready' || now() - listedAt >= FRESH_MS) {
        void list()
      }
      const number = read().selected
      if (number !== null) {
        void open(number)
      }
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
        void open(number, true)
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
