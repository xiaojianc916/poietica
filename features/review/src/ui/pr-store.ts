import { AppError } from '@poietica/foundation'
import type { FeatureStore } from '@poietica/ui-kernel'
import { createFeatureStore } from '@poietica/ui-kernel'
import type {
  GithubAvailability,
  GithubComment,
  GithubMergeMethod,
  GithubPullRequest,
  GithubPullSummary,
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
 * 列表与详情是两套字段：列表（github.pullRequests）只有画列表行要的那几样，进页面只等这一份；
 * 正文、检查项、合并状态与评论在打开某一条时才读（github.pullRequest + github.comments）。
 * 以前列表一次带回每一条的全部字段，进页面要等 GitHub 把所有 PR 的正文、检查项与合并状态都算完。
 *
 * 缓存：store 按工作区常驻（见 pr-store-holder），离开页面再回来，屏幕上直接是上次读到的东西，
 * 不再整页回到「加载中」。回来时数据若已过了 FRESH_MS，就在背后安静地重读一遍（stale-while-revalidate），
 * 读回来再换上；读失败也不把手上那份打掉。读过的详情与评论按编号记着，再点回来是即时的；
 * 鼠标停在某一行上就先在背后读它（prefetch），点下去时多半已经在手上。同一条同时只读一份。
 */

export type PrFilter = 'all' | 'prs' | 'issues'
export type PrTab = 'summary' | 'changes' | 'timeline'

export type PrListPhase = 'asking' | 'unavailable' | 'ready'

export type PrFactsPhase = 'idle' | 'loading' | 'ready' | 'missing' | 'unreadable'

export interface PrReading {
  readonly phase: PrListPhase
  readonly repository: GithubRepository | null
  readonly login: string | null
  readonly pulls: readonly GithubPullSummary[]
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
  readonly pullRequests: () => Promise<{ repository: GithubRepository | null; pulls: readonly GithubPullSummary[] }>
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
  /** 鼠标停在 / 焦点落在某一行：稍等一下（PREFETCH_DELAY_MS）还在，就先在背后读它的详情与评论。null 取消。 */
  readonly prefetch: (number: number | null) => void
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

/* 悬停多久才预读：鼠标只是扫过的那几行不发请求。 */
export const PREFETCH_DELAY_MS = 120

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

type Entry = { pull: GithubPullRequest | null; comments: readonly GithubComment[] | null; at: number }

/* 一次补读的结果：两样各自成败，交给 open 去决定怎么画、要不要报错（预读不报）。 */
interface Loaded {
  readonly facts: PromiseSettledResult<GithubPullRequest>
  readonly comments: PromiseSettledResult<readonly GithubComment[]>
}

function isMissing(cause: unknown): boolean {
  return cause instanceof AppError && String(cause.code).endsWith('pull_request_missing')
}

export function createPrStore(options: PrStoreOptions): PrStore {
  const { gateway, report } = options
  const now = options.now ?? Date.now
  const store = createFeatureStore<PrState>(() => ASKING)
  const read = (): PrState => store.getState()
  /* 每次重新列清单都换一代：旧代的列表回包不许再落到新状态上（Core 会重启，页面也会刷新）。 */
  let generation = 0
  /* 中栏此刻画的是哪一条；页面卸载时清空，还在路上的详情回包只记进缓存、不再画。 */
  let factsFor: number | null = null
  let stopWatch: (() => void) | null = null
  /* 上次列表读成功的时刻；0 表示还没读成过。 */
  let listedAt = 0
  /* 每条 PR 读回来的详情与评论（按编号），连同读到的时刻：再点回来先画它。 */
  const opened = new Map<number, Entry>()
  /* 正在读的那一份（按编号）：点开、预读、回到页面同时来时只发一份请求。 */
  const inflight = new Map<number, Promise<Loaded>>()
  let prefetchTimer: ReturnType<typeof setTimeout> | null = null

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

  /* 列表里的 updatedAt 与缓存的详情对不上：那一条在 GitHub 上变过，缓存当过期（下次打开重读）。 */
  function expireChanged(pulls: readonly GithubPullSummary[]): void {
    for (const pull of pulls) {
      const memo = opened.get(pull.number)
      if (memo?.pull != null && memo.pull.updatedAt !== pull.updatedAt) {
        memo.at = 0
      }
    }
  }

  function applyPage(
    login: string | null,
    page: { repository: GithubRepository | null; pulls: readonly GithubPullSummary[] },
  ): void {
    listedAt = now()
    expireChanged(page.pulls)
    publish({
      reading: { phase: 'ready', repository: page.repository, login, pulls: page.pulls },
      trouble: null,
      refreshing: false,
    })
    /* 正画着的那一条若刚被判过期，补读一次（已经在读就并进那一份）。 */
    const selected = read().selected
    if (selected !== null && factsFor === selected && opened.get(selected)?.at === 0) {
      void open(selected)
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
    /*
     * 「能不能用」与「列清单」同时发：前者要问一次 /user，后者要认仓库再查 GraphQL，两边互不依赖。
     * 以前是一前一后，进页面要多等一整个来回。不可用时清单那一路的结果（多半是「没凭据」）直接丢掉。
     */
    const [availability, page] = await Promise.allSettled([gateway.availability(), gateway.pullRequests()])
    if (mine !== generation) return
    if (availability.status === 'rejected') {
      listFailed(availability.reason, quiet)
      return
    }
    if (!availability.value.available) {
      markUnavailable(availability.value.reason)
      return
    }
    if (page.status === 'rejected') {
      listFailed(page.reason, quiet)
      return
    }
    applyPage(availability.value.login, page.value)
  }

  /* 打开时手上已有的：读过的详情 / 评论。 */
  function seedOf(number: number): {
    readonly memo: Entry | undefined
    readonly pull: GithubPullRequest | null
    readonly comments: readonly GithubComment[] | null
  } {
    const memo = opened.get(number)
    return { memo, pull: memo?.pull ?? null, comments: memo?.comments ?? null }
  }

  /* 要补读哪几样：force 两样都读；否则没读过的、过了新鲜期的才读。 */
  function needsOf(seed: ReturnType<typeof seedOf>, force: boolean): { pull: boolean; comments: boolean } {
    if (force) return { pull: true, comments: true }
    const stale = seed.memo === undefined || now() - seed.memo.at >= FRESH_MS
    return { pull: seed.pull === null || stale, comments: seed.comments === null || stale }
  }

  /* 读回来的先记进缓存（不管此刻画的是不是它）：两样都读成才记下时刻，读成「查无此条」的不记。 */
  function remember(number: number, loaded: Loaded): void {
    if (loaded.facts.status === 'rejected' && isMissing(loaded.facts.reason)) {
      opened.delete(number)
      return
    }
    const entry = opened.get(number) ?? { pull: null, comments: null, at: 0 }
    if (loaded.facts.status === 'fulfilled') entry.pull = loaded.facts.value
    if (loaded.comments.status === 'fulfilled') entry.comments = loaded.comments.value
    if (loaded.facts.status === 'fulfilled' && loaded.comments.status === 'fulfilled') entry.at = now()
    opened.set(number, entry)
  }

  /*
   * 补读一条（缺的或过期的那几样）。同一条已经在读就并进那一份；force（写操作之后、手动刷新）不并：
   * 在路上的那一份可能是写之前发的。
   */
  function load(number: number, force: boolean): Promise<Loaded> {
    const running = inflight.get(number)
    if (running !== undefined && !force) {
      return running
    }
    const seed = seedOf(number)
    const need = needsOf(seed, force)
    const task = Promise.allSettled([
      need.pull || seed.pull === null ? gateway.pullRequest(number) : Promise.resolve(seed.pull),
      need.comments || seed.comments === null ? gateway.comments(number) : Promise.resolve(seed.comments),
    ]).then(([facts, comments]): Loaded => {
      const loaded = { facts, comments }
      remember(number, loaded)
      if (inflight.get(number) === task) inflight.delete(number)
      return loaded
    })
    inflight.set(number, task)
    return task
  }

  function applyFacts(result: PromiseSettledResult<GithubPullRequest>, seedPull: GithubPullRequest | null): void {
    if (result.status === 'fulfilled') {
      publish({ facts: { phase: 'ready', pull: result.value } })
      return
    }
    report({ cause: result.reason })
    if (isMissing(result.reason)) {
      publish({ facts: { phase: 'missing', pull: null } })
    } else if (seedPull === null) {
      publish({ facts: { phase: 'unreadable', pull: null } })
    }
  }

  function applyComments(
    result: PromiseSettledResult<readonly GithubComment[]>,
    seedComments: readonly GithubComment[] | null,
  ): void {
    if (result.status === 'fulfilled') {
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

  /*
   * 打开某一条。先画手上有的（读过的、预读过的），所以点下去多半是即时的；再补读缺的或过期的（见 needsOf）。
   * 补读失败只在「手上什么都没有」时才降级成读不出来，已经画着的不打掉。
   * 回包落地前用户换了一条（或离开了页面）：结果照样进缓存，只是不画。
   */
  async function open(number: number, force = false): Promise<void> {
    const switching = factsFor !== number || read().selected !== number
    factsFor = number
    const seed = seedOf(number)
    showSeed(number, seed, switching)
    const need = needsOf(seed, force)
    if (!need.pull && !need.comments && !inflight.has(number)) {
      return
    }
    const loaded = await load(number, force)
    if (factsFor !== number) return
    applyFacts(loaded.facts, seed.pull)
    applyComments(loaded.comments, seed.comments)
  }

  function cancelPrefetch(): void {
    if (prefetchTimer !== null) {
      clearTimeout(prefetchTimer)
      prefetchTimer = null
    }
  }

  /* 预读：只读缺的或过期的；失败不报（真点开时 open 会再读并报）。 */
  function prefetch(number: number | null): void {
    cancelPrefetch()
    if (number === null) return
    const need = needsOf(seedOf(number), false)
    if ((!need.pull && !need.comments) || inflight.has(number)) return
    prefetchTimer = setTimeout(() => {
      prefetchTimer = null
      void load(number, false)
    }, PREFETCH_DELAY_MS)
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
        cancelPrefetch()
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
      cancelPrefetch()
      if (number === null) {
        factsFor = null
        publish({ selected: null, facts: { phase: 'idle', pull: null }, comments: { phase: 'idle', items: [] } })
        return
      }
      void open(number)
    },
    prefetch,
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
export function visiblePulls<T extends GithubPullSummary>(
  pulls: readonly T[],
  filter: PrFilter,
  query: string,
): readonly T[] {
  const needle = query.trim().toLowerCase()
  return pulls.filter((pull) => {
    if (filter === 'prs' && pull.state === 'closed') return false
    if (filter === 'issues') return false
    if (needle === '') return true
    return pull.title.toLowerCase().includes(needle) || `#${String(pull.number)}`.includes(needle)
  })
}

export function filterCounts(pulls: readonly GithubPullSummary[]): {
  readonly all: number
  readonly prs: number
  readonly issues: number
} {
  return { all: pulls.length, prs: pulls.length, issues: 0 }
}
