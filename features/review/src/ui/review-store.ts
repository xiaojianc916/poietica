import type { DiffFile, DiffRow, DiffStat } from '@poietica/design-system/diff'
import { diffStatOf } from '@poietica/design-system/diff'
import { InvariantError, invariant, mapLimited } from '@poietica/foundation'
import type { FeatureStore } from '@poietica/ui-kernel'
import { createFeatureStore } from '@poietica/ui-kernel'
import type { GitStatus, ReviewFile } from '../contract'

/* 审查面的状态机：清单走 git.review，打开的文件才经 git.filePatch 补行带。统计与处境只认清单，补丁只补正文 ——
 * 展开、折叠与 Worker 返回都不能换成第二套数字。补丁缓存按清单的读取代次作键：净增行数相同也可能是不同内容。 */

export type SplitterActivity = 'idle' | 'hover' | 'drag'

/** 影响 git 问法的开关要重问，只影响推导的重推即可，不白跑进程往返。 */
export interface ReviewPresentation {
  readonly wrap: boolean
  readonly wordDiff: boolean
  readonly hideWhitespace: boolean
}
export type ReviewSwitch = keyof ReviewPresentation

export type ReviewReading =
  | { readonly phase: 'asking' | 'notARepository' | 'unreadable' }
  | {
      readonly phase: 'ready'
      readonly head: string | null
      readonly detachedAt: string | null
      readonly upstream: string | null
      readonly ahead: number
      readonly behind: number
      readonly branches: readonly string[]
      readonly files: readonly DiffFile[]
      readonly staged: ReadonlySet<string>
      readonly stat: DiffStat
      readonly statuses: ReadonlyMap<string, ReviewFile['change']>
      readonly unstaged: DiffStat
    }

export interface ReviewState {
  readonly reading: ReviewReading
  readonly presentation: ReviewPresentation
  readonly base: string

  readonly draft: string
  readonly stageAll: boolean
  readonly query: string
  readonly openFiles: ReadonlySet<string>
  readonly collapsedFolders: ReadonlySet<string>
  readonly openGaps: ReadonlySet<string>
  readonly treeOpen: boolean
  readonly treeWidth: number
  readonly splitter: SplitterActivity
  readonly busy: boolean
}

export interface ReviewStore {
  readonly store: FeatureStore<ReviewState>
  readonly start: () => () => void
  readonly setQuery: (value: string) => void
  readonly setDraft: (value: string) => void
  readonly setStageAll: (on: boolean) => void
  readonly setBase: (ref: string) => void
  readonly toggleFile: (path: string) => void
  readonly openFile: (path: string) => void
  readonly setAllOpen: (open: boolean) => void
  readonly toggleFolder: (key: string) => void
  readonly toggleGap: (key: string) => void
  readonly toggleSwitch: (name: ReviewSwitch) => void
  readonly toggleTree: () => void
  readonly setTreeWidth: (width: number) => void
  readonly setSplitter: (activity: SplitterActivity) => void
  readonly refresh: () => void
  readonly commit: (intent: ReviewCommitIntent) => void
  /** 一条命令要拼全部文件的补丁，而补丁是按需取的，所以它是异步的；没有变更时交回空串。 */
  readonly applyCommand: () => Promise<string>
  readonly hasChanges: () => boolean
}

export type ReviewCommitIntent = 'commit' | 'commit-and-push' | 'push'

/* 命令体是 `git apply --3way` 读 stdin。逐行的三行上下文由 git 自己的默认值给。 */
const APPLY_HEAD = "git apply --3way - <<'PATCH'\n"
const APPLY_TAIL = '\nPATCH\n'
/* 一条命令要取全部文件的补丁；进程往返可重叠，但并发封顶，别把整张清单一次全打给 git。 */
const APPLY_CONCURRENCY = 8

export const WORKTREE_BASE = 'HEAD'
export const TREE_MIN = 180
export const TREE_MAX = 480

export type ReviewDerive = (patch: string, wordDiff: boolean) => Promise<readonly DiffFile[]>

export type ReviewFailureReport = (
  code: 'GIT_CHANGES_UNREADABLE' | 'GIT_REVIEW_ACTION_FAILED',
  context: { readonly cause: unknown },
) => void

export interface ReviewGateway {
  review(base: string, ignoreWhitespace: boolean): Promise<ReviewAnswer | null>
  filePatch(base: string, path: string, ignoreWhitespace: boolean): Promise<string>
  watch(onChange: () => void): Promise<() => Promise<void>>
  commit(request: { base: string; intent: ReviewCommitIntent; message: string; stageAll: boolean }): Promise<unknown>
  readonly workspaceId: string
}

/** 一趟清单读取的全部事实（`git.review` + 状态 + 分支名）。 */
export interface ReviewAnswer {
  readonly status: GitStatus
  readonly changes: readonly ReviewFile[]
  readonly staged: readonly string[]
  readonly branches: readonly string[]
}

export interface ReviewStoreOptions {
  readonly gateway: ReviewGateway
  readonly derive: ReviewDerive
  readonly report: ReviewFailureReport
}

export function createReviewStore(options: ReviewStoreOptions): ReviewStore {
  const { gateway, derive, report } = options
  interface Observation {
    readonly cancellation: AbortController
    readonly attempted: Map<string, string>
    /** 这个观察者已经读过几趟清单：补丁缓存的身份就按它算。 */
    listingVersion: number
    release: (() => Promise<void>) | null
    queued: boolean
    reading: boolean
    enriching: boolean
    queryVersion: number
  }
  let observation: Observation | null = null
  let answer: ReviewAnswer | null = null
  let trouble: 'asking' | 'notARepository' | 'unreadable' = 'asking'
  let listing: readonly DiffFile[] = []

  const wholeFiles = new Map<string, { key: string; file: DiffFile }>()
  let projectionVersion = 0
  let draftVersion = 0

  const snapshot0: ReviewState = {
    reading: { phase: 'asking' },
    presentation: { wrap: false, wordDiff: true, hideWhitespace: false },
    base: WORKTREE_BASE,
    draft: '',
    stageAll: true,
    query: '',
    openFiles: new Set<string>(),
    collapsedFolders: new Set<string>(),
    openGaps: new Set<string>(),
    treeOpen: false,
    treeWidth: 240,
    splitter: 'idle',
    busy: false,
  }

  const store = createFeatureStore<ReviewState>(() => snapshot0)
  const read = (): ReviewState => store.getState()

  function current(owner: Observation): boolean {
    return observation === owner && !owner.cancellation.signal.aborted
  }
  function publish(change: Partial<ReviewState>): void {
    const before = read()
    const next = { ...before, ...change }
    if (
      Object.keys(change).every((name) => {
        const key = name as keyof ReviewState
        return Object.is(before[key], next[key])
      })
    ) {
      return
    }
    store.setState(next)
  }
  /* 缓存键只说「同一份清单的哪一趟读取」：净增行数相同也可能是不同内容，所以内容身份只认清单读回来的代次，
   * 不从补丁正文反推（那会把旧缓存自己的统计当成新清单的指纹）。 */
  function keyFor(owner: Observation): string {
    return JSON.stringify([
      read().base,
      read().presentation.hideWhitespace,
      read().presentation.wordDiff,
      owner.listingVersion,
    ])
  }
  function pending(owner: Observation): DiffFile | undefined {
    const held = read()
    if (held.reading.phase !== 'ready') {
      return undefined
    }
    const key = keyFor(owner)
    return held.reading.files.find((file) => {
      if (!held.openFiles.has(file.path) || file.binary) {
        return false
      }
      return wholeFiles.get(file.path)?.key !== key && owner.attempted.get(file.path) !== key
    })
  }
  function project(): void {
    projectionVersion += 1
    observation?.attempted.clear()
    if (answer === null) {
      publish({ reading: { phase: trouble } })
      return
    }
    /* 清单是统计的唯一来源：这一趟读回来的加减数直接写进 shown，不从上一趟的旧条目里复用。 */
    const fresh = answer.changes.map((entry) => ({
      binary: entry.binary,
      path: entry.path,
      rows: EMPTY_ROWS,
      stat: { added: entry.additions, removed: entry.deletions },
    }))
    listing = fresh
    const livePaths = new Set(listing.map((file) => file.path))
    for (const file of wholeFiles.keys()) {
      if (!livePaths.has(file)) {
        wholeFiles.delete(file)
      }
    }
    const held = read()
    const owner = observation
    const files = listing.map((file) => {
      const cached = wholeFiles.get(file.path)
      if (owner === null || !held.openFiles.has(file.path) || cached === undefined) {
        return file
      }
      return cached.key === keyFor(owner) ? cached.file : file
    })
    publish({ reading: ready(answer, files) })
    enrich()
  }
  function enrich(): void {
    const owner = observation
    if (owner === null || !current(owner) || owner.enriching || read().busy) {
      return
    }
    owner.enriching = true
    void (async () => {
      try {
        while (current(owner) && !read().busy) {
          const wanted = pending(owner)
          if (wanted === undefined) {
            break
          }
          /* 串行排空：本地 git RPC 一次一份、reading 按顺序刷新；并发需要另做有界池与顺序测试，收益只有已打开的那几份文件。 */
          // react-doctor-disable-next-line react-doctor/async-await-in-loop
          await enrichOne(owner, wanted)
        }
      } finally {
        owner.enriching = false
      }
    })().catch((cause: unknown) => {
      if (current(owner)) {
        report('GIT_CHANGES_UNREADABLE', { cause })
      }
    })
  }
  async function enrichOne(owner: Observation, wanted: DiffFile): Promise<void> {
    const version = projectionVersion
    const requestedBase = read().base
    const { hideWhitespace, wordDiff } = read().presentation
    const key = keyFor(owner)
    owner.attempted.set(wanted.path, key)
    const fresh = (): boolean => current(owner) && version === projectionVersion && read().openFiles.has(wanted.path)
    try {
      const patch = await gateway.filePatch(requestedBase, wanted.path, hideWhitespace)
      if (!fresh()) {
        return
      }
      const files = await derive(patch, wordDiff)
      if (!fresh()) {
        return
      }
      const derived = files.find((item) => item.path === wanted.path)
      if (derived === undefined) {
        invariant(false, 'Derived patch does not contain the requested file.')
      }
      /* 补丁只补正文：统计与二进制判定仍以清单为准，展开前后与工具条、Git 工具格因此永远是同一组数。 */
      const file: DiffFile = { ...wanted, rows: derived.rows }
      const held = read().reading
      if (held.phase !== 'ready') {
        return
      }
      wholeFiles.set(wanted.path, { key, file })
      publish({
        reading: {
          ...held,
          files: held.files.map((item) => (item.path === wanted.path ? file : item)),
        },
      })
    } catch (cause: unknown) {
      if (current(owner) && version === projectionVersion) {
        report('GIT_CHANGES_UNREADABLE', { cause })
      }
    }
  }
  async function load(owner: Observation): Promise<void> {
    const version = ++owner.queryVersion
    const requestedBase = read().base
    const ignoreWhitespace = read().presentation.hideWhitespace
    try {
      const result = await gateway.review(requestedBase, ignoreWhitespace)
      if (!current(owner) || owner.queryVersion !== version) {
        return
      }
      answer = result
      trouble = result === null ? 'notARepository' : 'asking'
      /* 清单读回来了：补丁缓存的身份跟着这一趟走 —— 展开前后、以及与上一趟之间都不会串。 */
      owner.listingVersion += 1
    } catch (cause: unknown) {
      if (!current(owner) || owner.queryVersion !== version) {
        return
      }
      answer = null
      trouble = 'unreadable'
      report('GIT_CHANGES_UNREADABLE', { cause })
    }
    project()
  }
  function pump(owner: Observation): void {
    if (!current(owner) || owner.reading || read().busy) {
      return
    }
    owner.reading = true
    void (async () => {
      try {
        while (current(owner) && owner.queued && !read().busy) {
          owner.queued = false
          await load(owner)
        }
      } finally {
        owner.reading = false
        if (current(owner) && owner.queued && !read().busy) {
          pump(owner)
        }
      }
    })().catch((cause: unknown) => {
      if (current(owner)) {
        report('GIT_CHANGES_UNREADABLE', { cause })
      }
    })
  }
  function refresh(): void {
    const owner = observation
    if (owner !== null && current(owner)) {
      owner.queued = true
      pump(owner)
    }
  }
  function invalidateQuery(change: Partial<ReviewState>): void {
    if (observation !== null) {
      observation.queryVersion += 1
      observation.attempted.clear()
      observation.listingVersion += 1
    }
    projectionVersion += 1
    answer = null
    listing = EMPTY_LISTING
    wholeFiles.clear()
    trouble = 'asking'
    publish({ ...change, reading: { phase: 'asking' } })
    refresh()
  }
  function releaseSubscription(release: () => Promise<void>): void {
    void Promise.resolve()
      .then(release)
      .catch((cause: unknown) => {
        report('GIT_CHANGES_UNREADABLE', { cause })
      })
  }
  async function attach(owner: Observation): Promise<void> {
    try {
      const release = await gateway.watch(() => {
        if (current(owner)) {
          refresh()
        }
      })
      if (!current(owner)) {
        releaseSubscription(release)
        return
      }
      owner.release = release
      refresh()
    } catch (cause: unknown) {
      if (current(owner)) {
        report('GIT_CHANGES_UNREADABLE', { cause })
        refresh()
      }
    }
  }

  return {
    store,
    hasChanges: () => listing.length > 0,
    applyCommand: async () => {
      const held = answer
      if (held === null || held.changes.length === 0) {
        return ''
      }
      const base = read().base
      const ignoreWhitespace = read().presentation.hideWhitespace
      /* 每个补丁的 git 调用互不依赖，拼进同一条命令时顺序仍按清单；有界并发只压住同时在跑的进程数。 */
      const patches = await mapLimited(held.changes, APPLY_CONCURRENCY, (change) =>
        gateway.filePatch(base, change.path, ignoreWhitespace),
      )
      const joined = patches.filter((patch) => patch !== '').join('')
      return joined === '' ? '' : APPLY_HEAD + joined + APPLY_TAIL
    },
    refresh,
    start: () => {
      if (observation !== null) {
        invariant(false, 'ReviewStore is already started.')
      }
      const owner: Observation = {
        cancellation: new AbortController(),
        attempted: new Map<string, string>(),
        listingVersion: 0,
        release: null,
        queued: false,
        reading: false,
        enriching: false,
        queryVersion: 0,
      }
      observation = owner
      void attach(owner)
      refresh()
      return () => {
        if (!current(owner)) {
          return
        }
        observation = null
        owner.cancellation.abort()
        owner.queued = false
        owner.queryVersion += 1
        projectionVersion += 1
        const release = owner.release
        owner.release = null
        if (release !== null) {
          releaseSubscription(release)
        }
      }
    },
    commit: (intent) => {
      const held = read()
      if (held.busy) {
        return
      }
      if (observation === null) {
        report('GIT_REVIEW_ACTION_FAILED', {
          cause: new InvariantError('Review observation is not started.'),
        })
        return
      }
      const writtenVersion = draftVersion
      const request = {
        base: held.base,
        intent,
        message: subjectFor(intent, held.draft, held.reading),
        stageAll: held.stageAll,
      }
      observation.queryVersion += 1
      projectionVersion += 1
      publish({ busy: true })
      void Promise.resolve()
        .then(() => gateway.commit(request))
        .then(
          () => {
            if (intent !== 'push' && draftVersion === writtenVersion) {
              publish({ draft: '' })
            }
          },
          (cause: unknown) => report('GIT_REVIEW_ACTION_FAILED', { cause }),
        )
        .finally(() => {
          publish({ busy: false })
          if (observation !== null) {
            observation.queryVersion += 1
          }
          refresh()
        })
        .catch((cause: unknown) => {
          report('GIT_REVIEW_ACTION_FAILED', { cause })
        })
    },
    setBase: (base) => {
      if (base !== read().base) {
        invalidateQuery({ base })
      }
    },
    setDraft: (draft) => {
      if (draft !== read().draft) {
        draftVersion += 1
        publish({ draft })
      }
    },
    setStageAll: (stageAll) => publish({ stageAll }),
    setQuery: (query) => publish({ query }),
    setSplitter: (splitter) => publish({ splitter }),
    setTreeWidth: (width) => {
      if (!Number.isFinite(width)) {
        invariant(false, 'Review tree width must be finite.')
      }
      publish({ treeWidth: Math.max(TREE_MIN, Math.min(TREE_MAX, Math.round(width))) })
    },
    toggleTree: () => {
      const held = read()
      const treeOpen = !held.treeOpen
      publish({ treeOpen, query: treeOpen ? held.query : '' })
    },
    openFile: (file) => {
      if (!read().openFiles.has(file)) {
        publish({ openFiles: new Set(read().openFiles).add(file) })
        observation?.attempted.delete(file)
        project()
      }
    },
    toggleFile: (file) => {
      publish({ openFiles: flipped(read().openFiles, file) })
      observation?.attempted.delete(file)
      project()
    },
    setAllOpen: (open) => {
      const held = read()
      publish({
        openFiles:
          open && held.reading.phase === 'ready'
            ? new Set(held.reading.files.map((file) => file.path))
            : new Set<string>(),
      })
      project()
    },
    toggleFolder: (key) => publish({ collapsedFolders: flipped(read().collapsedFolders, key) }),
    toggleGap: (key) => publish({ openGaps: flipped(read().openGaps, key) }),
    toggleSwitch: (name) => {
      const presentation = switched(read().presentation, name)
      if (name === 'hideWhitespace') {
        invalidateQuery({ presentation })
        return
      }
      publish({ presentation })
      if (name === 'wordDiff') {
        wholeFiles.clear()
        project()
      }
    },
  }
}

/* 清单读回来的那一份在展开之前没有行带 —— 共享同一个空数组，省掉每条都新建。 */
const EMPTY_ROWS: readonly DiffRow[] = []
const EMPTY_LISTING: readonly DiffFile[] = []
const NOTHING: DiffStat = { added: 0, removed: 0 }

/* 文件清单与它的统计都从这一份来：总账就是清单上每一处加减的和，与卡头逐字同源。处境取 git.review 的字段：
 * 暂存区里有同名条目时以那一份为准（它才是「相对 HEAD 的处境」）。 */
function ready(held: ReviewAnswer, files: readonly DiffFile[]): ReviewReading {
  const staged = new Set(held.staged)
  const statuses = new Map<string, ReviewFile['change']>()
  for (const entry of held.status.staged) {
    statuses.set(entry.path, entry.change)
  }
  for (const entry of held.status.unstaged) {
    if (!statuses.has(entry.path)) {
      statuses.set(entry.path, entry.change)
    }
  }
  return {
    ahead: held.status.ahead,
    behind: held.status.behind,
    branches: held.branches,
    detachedAt: held.status.detachedAt,
    files,
    head: held.status.branch,
    phase: 'ready',
    staged,
    stat: diffStatOf(files) ?? NOTHING,
    statuses,
    unstaged: diffStatOf(files.filter((file) => !staged.has(file.path))) ?? NOTHING,
    upstream: held.status.upstream,
  }
}

/* 确定性的，不牵进一次模型调用。 */
function subjectFor(intent: ReviewCommitIntent, message: string, reading: ReviewReading): string {
  if (intent === 'push') {
    return ''
  }
  const written = message.trim()
  if (written !== '') {
    return written
  }
  return reading.phase === 'ready' ? autoSubject(reading.files) : ''
}

function autoSubject(files: readonly DiffFile[]): string {
  const paths = files.map((file) => file.path)
  const first = paths[0]
  if (first === undefined) {
    return ''
  }
  if (paths.length === 1) {
    return `update ${first}`
  }
  const shared = commonFolder(paths)
  const counted = `update ${String(paths.length)} files`
  return shared === '' ? counted : `${counted} in ${shared}`
}

function commonFolder(paths: readonly string[]): string {
  const parts = (paths[0] ?? '').split('/').slice(0, -1)
  let depth = parts.length
  for (const held of paths) {
    const other = held.split('/').slice(0, -1)
    let index = 0
    while (index < depth && index < other.length && parts[index] === other[index]) {
      index += 1
    }
    depth = index
  }
  return parts.slice(0, depth).join('/')
}

function flipped(held: ReadonlySet<string>, key: string): ReadonlySet<string> {
  const next = new Set(held)
  if (!next.delete(key)) {
    next.add(key)
  }
  return next
}

function switched(held: ReviewPresentation, name: ReviewSwitch): ReviewPresentation {
  return {
    hideWhitespace: name === 'hideWhitespace' ? !held.hideWhitespace : held.hideWhitespace,
    wordDiff: name === 'wordDiff' ? !held.wordDiff : held.wordDiff,
    wrap: name === 'wrap' ? !held.wrap : held.wrap,
  }
}
