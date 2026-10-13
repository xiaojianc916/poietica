import type { DiffFile, DiffStat } from '@poietica/design-system/diff'
import { diffStatOf } from '@poietica/design-system/diff'
import { InvariantError, invariant } from '@poietica/foundation'
import type { FeatureStore } from '@poietica/ui-kernel'
import { createFeatureStore } from '@poietica/ui-kernel'
import type { GitStatus, ReviewFile } from '../contract'

/* 审查面的状态机。状态与投影规则照 legacy 逐条保留：读清单 → 打开的文件补全量补丁 → 词级强调重推。差别只在清单的来路 ——
 * legacy 的原生侧一次给回「清单 + 全部文件 -U3 补丁」，新契约把两件事分开：清单走 git.review（每个文件的加减行数就是它的字段），
 * 行带只在打开某个文件时经 git.filePatch 取回；清单里的 stat / binary 因此直接来自 git，不是从补丁正文数出来的。 */

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

export const WORKTREE_BASE = 'HEAD'
export const TREE_MIN = 180
export const TREE_MAX = 480

export type ReviewDerive = (patch: string, wordDiff: boolean) => Promise<readonly DiffFile[]>

export type ReviewFailureReport = (
  code: 'GIT_CHANGES_UNREADABLE' | 'GIT_REVIEW_ACTION_FAILED',
  context: { readonly cause: unknown },
) => void

export interface ReviewGateway {
  review(
    base: string,
    ignoreWhitespace: boolean,
  ): Promise<{
    readonly status: GitStatus
    readonly changes: readonly ReviewFile[]
    readonly staged: readonly string[]
    readonly branches: readonly string[]
  } | null>
  filePatch(base: string, path: string, ignoreWhitespace: boolean): Promise<string>
  watch(onChange: () => void): Promise<() => Promise<void>>
  commit(request: { base: string; intent: ReviewCommitIntent; message: string; stageAll: boolean }): Promise<unknown>
  readonly workspaceId: string
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
    release: (() => Promise<void>) | null
    queued: boolean
    reading: boolean
    enriching: boolean
    queryVersion: number
  }
  let observation: Observation | null = null
  let answer: {
    readonly status: GitStatus
    readonly changes: readonly ReviewFile[]
    readonly staged: readonly string[]
    readonly branches: readonly string[]
  } | null = null
  let trouble: 'asking' | 'notARepository' | 'unreadable' = 'asking'
  let listing: readonly DiffFile[] = []
  /* keyFor 在 find/map 里逐条调用，现查一遍就是 O(n²)。 */
  let byPath = new Map<string, DiffFile>()

  function setListing(files: readonly DiffFile[]): void {
    listing = files
    byPath = new Map(files.map((file) => [file.path, file] as const))
  }

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
  function keyFor(file: DiffFile): string {
    return JSON.stringify([
      read().base,
      read().presentation.hideWhitespace,
      read().presentation.wordDiff,
      fingerprintOf(byPath.get(file.path) ?? file),
    ])
  }
  function pending(owner: Observation): DiffFile | undefined {
    const held = read()
    if (held.reading.phase !== 'ready') {
      return undefined
    }
    return held.reading.files.find((file) => {
      if (!held.openFiles.has(file.path) || file.binary) {
        return false
      }
      const key = keyFor(file)
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
    const fresh = answer.changes.map(
      (entry) =>
        byPath.get(entry.path) ?? {
          binary: entry.binary,
          path: entry.path,
          rows: [],
          stat: { added: entry.additions, removed: entry.deletions },
        },
    )
    setListing(fresh)
    const livePaths = new Set(listing.map((file) => file.path))
    for (const file of wholeFiles.keys()) {
      if (!livePaths.has(file)) {
        wholeFiles.delete(file)
      }
    }
    const held = read()
    const files = listing.map((file) => {
      const cached = wholeFiles.get(file.path)
      if (!held.openFiles.has(file.path) || cached?.key !== keyFor(file)) {
        return file
      }
      return cached.file
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
    const key = keyFor(wanted)
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
      const file = files.find((item) => item.path === wanted.path)
      if (file === undefined) {
        invariant(false, 'Derived patch does not contain the requested file.')
      }
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
    }
    projectionVersion += 1
    answer = null
    setListing([])
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
      const ignoreWhitespace = read().presentation.hideWhitespace
      const patches: string[] = []
      for (const change of held.changes) {
        patches.push(await gateway.filePatch(read().base, change.path, ignoreWhitespace))
      }
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

const NOTHING: DiffStat = { added: 0, removed: 0 }

function fingerprintOf(file: DiffFile): string {
  let key = `${String(file.stat.added)}/${String(file.stat.removed)}`
  for (const row of file.rows) {
    key += `${row.kind[0]}${row.number === null ? '' : String(row.number)}:${row.text}\n`
  }
  return key
}

/* 清单是权威顺序，补丁按路径对上去，补丁里有而清单里没有的照实附在后面。处境取 git.review 的字段：暂存区里有同名条目时以暂存
 * 那一份为准（它才是「相对 HEAD 的处境」）。 */
function ready(
  held: {
    readonly status: GitStatus
    readonly changes: readonly ReviewFile[]
    readonly staged: readonly string[]
    readonly branches: readonly string[]
  },
  parsed: readonly DiffFile[],
): ReviewReading {
  const byPath = new Map(parsed.map((file) => [file.path, file] as const))
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
  const files: DiffFile[] = []
  for (const change of held.changes) {
    files.push(byPath.get(change.path) ?? blank(change.path))
    byPath.delete(change.path)
  }
  files.push(...byPath.values())
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

function blank(path: string): DiffFile {
  return { binary: false, path, rows: [], stat: NOTHING }
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
