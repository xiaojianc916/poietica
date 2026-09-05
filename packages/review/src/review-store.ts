import type { GitCommitIntent, GitReview } from '@poietica/contract/review'
import { createExternalStore } from '@poietica/external-store'
import type { ReviewFailureReport, ReviewGateway } from './review-gateway'
import { type DiffFile, type DiffStat, diffStatOf, parseUnifiedPatch } from './unified-diff'

export type SplitterActivity = 'idle' | 'hover' | 'drag'

/** 影响 git 问法的开关要重问，只影响推导的重推即可 —— 两组分开，不白跑进程往返。 */
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
      /** 未暂存那一部分的加减行数：提交面板上那个勾选项管着的正是它。 */
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
  readonly subscribe: (listen: () => void) => () => void
  readonly getSnapshot: () => ReviewState

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
  readonly commit: (intent: GitCommitIntent) => void
  readonly applyCommand: () => string
}
/* 每次跳动只问 git 默认的三行上下文；整份文件由开着的那几份自己去取。 */
const TIGHT = 3
const APPLY_HEAD = "git apply --3way - <<'PATCH'\n"
const APPLY_TAIL = '\nPATCH\n'

export const WORKTREE_BASE = 'HEAD'
/** 文件树的宽度区间：分隔条与 store 的收敛读同一份。 */
export const TREE_MIN = 180
export const TREE_MAX = 480

export type ReviewDerive = (patch: string, wordDiff: boolean) => Promise<readonly DiffFile[]>

export interface ReviewStoreOptions {
  readonly root: string
  readonly gateway: ReviewGateway
  readonly derive: ReviewDerive
  readonly report: ReviewFailureReport
}

export function createReviewStore(options: ReviewStoreOptions): ReviewStore {
  const { root, gateway, derive, report } = options
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
  let answer: GitReview | null = null
  let trouble: 'asking' | 'notARepository' | 'unreadable' = 'asking'
  let listing: { patch: string; files: readonly DiffFile[] } = { patch: '', files: [] }
  const wholeFiles = new Map<string, { key: string; file: DiffFile }>()
  let projectionVersion = 0
  let draftVersion = 0
  let snapshot: ReviewState = {
    reading: { phase: 'asking' },
    presentation: { wrap: false, wordDiff: true, hideWhitespace: false },
    base: WORKTREE_BASE,
    draft: '',
    stageAll: true,
    query: '',
    openFiles: new Set<string>(),
    collapsedFolders: new Set<string>(),
    openGaps: new Set<string>(),
    treeOpen: true,
    treeWidth: 240,
    splitter: 'idle',
    busy: false,
  }
  const store = createExternalStore<ReviewState>({ read: () => snapshot })

  function current(owner: Observation): boolean {
    return observation === owner && !owner.cancellation.signal.aborted
  }
  function publish(change: Partial<ReviewState>): void {
    const next = { ...snapshot, ...change }
    if (
      Object.keys(change).every((name) => {
        const key = name as keyof ReviewState
        return Object.is(snapshot[key], next[key])
      })
    ) {
      return
    }
    snapshot = next
    store.notify()
  }
  function keyFor(file: DiffFile): string {
    return JSON.stringify([
      snapshot.base,
      snapshot.presentation.hideWhitespace,
      snapshot.presentation.wordDiff,
      fingerprintOf(listing.files.find((item) => item.path === file.path) ?? file),
    ])
  }
  function pending(owner: Observation): DiffFile | undefined {
    if (snapshot.reading.phase !== 'ready') {
      return undefined
    }
    return snapshot.reading.files.find(
      (file) =>
        snapshot.openFiles.has(file.path) &&
        !file.binary &&
        wholeFiles.get(file.path)?.key !== keyFor(file) &&
        owner.attempted.get(file.path) !== keyFor(file),
    )
  }
  function project(): void {
    projectionVersion += 1
    observation?.attempted.clear()
    if (answer === null) {
      publish({ reading: { phase: trouble } })
      return
    }
    if (answer.patch !== listing.patch) {
      listing = { patch: answer.patch, files: parseUnifiedPatch(answer.patch, false) }
    }
    const livePaths = new Set(listing.files.map((file) => file.path))
    for (const file of wholeFiles.keys()) {
      if (!livePaths.has(file)) {
        wholeFiles.delete(file)
      }
    }
    const files = listing.files.map((file) => {
      const cached = wholeFiles.get(file.path)
      if (!snapshot.openFiles.has(file.path) || cached?.key !== keyFor(file)) {
        return file
      }
      return cached.file
    })
    publish({ reading: ready(answer, files) })
    enrich()
  }
  function enrich(): void {
    const owner = observation
    if (owner === null || !current(owner) || owner.enriching || snapshot.busy) {
      return
    }
    owner.enriching = true
    void (async () => {
      try {
        while (current(owner) && !snapshot.busy) {
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
    const requestedBase = snapshot.base
    const { hideWhitespace, wordDiff } = snapshot.presentation
    const key = keyFor(wanted)
    owner.attempted.set(wanted.path, key)
    const fresh = (): boolean =>
      current(owner) && version === projectionVersion && snapshot.openFiles.has(wanted.path)
    try {
      const patch = await gateway.filePatch(root, requestedBase, wanted.path, hideWhitespace)
      if (!fresh()) {
        return
      }
      const files = await derive(patch, wordDiff)
      if (!fresh()) {
        return
      }
      const file = files.find((item) => item.path === wanted.path)
      if (file === undefined) {
        throw new Error('Derived patch does not contain the requested file.')
      }
      const held = snapshot.reading
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
    const requestedBase = snapshot.base
    const ignoreWhitespace = snapshot.presentation.hideWhitespace
    try {
      const result = await gateway.review(root, requestedBase, TIGHT, ignoreWhitespace)
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
    if (!current(owner) || owner.reading || snapshot.busy) {
      return
    }
    owner.reading = true
    void (async () => {
      try {
        while (current(owner) && owner.queued && !snapshot.busy) {
          owner.queued = false
          await load(owner)
        }
      } finally {
        owner.reading = false
        if (current(owner) && owner.queued && !snapshot.busy) {
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
    listing = { patch: '', files: [] }
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
      const release = await gateway.watch(root, () => {
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
    getSnapshot: () => snapshot,
    subscribe: store.subscribe,
    applyCommand: () =>
      answer === null || answer.patch === '' ? '' : APPLY_HEAD + answer.patch + APPLY_TAIL,
    refresh,
    start: () => {
      if (observation !== null) {
        throw new Error('ReviewStore is already started.')
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
      if (snapshot.busy) {
        return
      }
      if (observation === null) {
        report('GIT_REVIEW_ACTION_FAILED', {
          cause: new Error('Review observation is not started.'),
        })
        return
      }
      const writtenVersion = draftVersion
      const request = {
        root,
        base: snapshot.base,
        context: TIGHT,
        ignoreWhitespace: snapshot.presentation.hideWhitespace,
        intent,
        message: subjectFor(intent, snapshot.draft, snapshot.reading),
        stageAll: snapshot.stageAll,
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
      if (base !== snapshot.base) {
        invalidateQuery({ base })
      }
    },
    setDraft: (draft) => {
      if (draft !== snapshot.draft) {
        draftVersion += 1
        publish({ draft })
      }
    },
    setStageAll: (stageAll) => publish({ stageAll }),
    setQuery: (query) => publish({ query }),
    setSplitter: (splitter) => publish({ splitter }),
    setTreeWidth: (width) => {
      if (!Number.isFinite(width)) {
        throw new Error('Review tree width must be finite.')
      }
      publish({ treeWidth: Math.max(TREE_MIN, Math.min(TREE_MAX, Math.round(width))) })
    },
    toggleTree: () => {
      const treeOpen = !snapshot.treeOpen
      publish({ treeOpen, query: treeOpen ? snapshot.query : '' })
    },
    openFile: (file) => {
      if (!snapshot.openFiles.has(file)) {
        publish({ openFiles: new Set(snapshot.openFiles).add(file) })
        observation?.attempted.delete(file)
        project()
      }
    },
    toggleFile: (file) => {
      publish({ openFiles: flipped(snapshot.openFiles, file) })
      observation?.attempted.delete(file)
      project()
    },
    setAllOpen: (open) => {
      publish({
        openFiles:
          open && snapshot.reading.phase === 'ready'
            ? new Set(snapshot.reading.files.map((file) => file.path))
            : new Set<string>(),
      })
      project()
    },
    toggleFolder: (key) => publish({ collapsedFolders: flipped(snapshot.collapsedFolders, key) }),
    toggleGap: (key) => publish({ openGaps: flipped(snapshot.openGaps, key) }),
    toggleSwitch: (name) => {
      const presentation = switched(snapshot.presentation, name)
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
/* 清单模型的指纹：行种、行号与正文。两跳一致即「这个文件没动」，全文模型可沿用。 */
function fingerprintOf(file: DiffFile): string {
  let key = `${String(file.stat.added)}/${String(file.stat.removed)}`
  for (const row of file.rows) {
    key += `${row.kind[0]}${row.number === null ? '' : String(row.number)}:${row.text}\n`
  }
  return key
}
/* 清单是权威顺序，补丁按路径对上去；补丁里有而清单里没有的照实附在后面。 */
function ready(held: GitReview, parsed: readonly DiffFile[]): ReviewReading {
  const byPath = new Map(parsed.map((file) => [file.path, file] as const))
  const staged = new Set<string>()
  const files: DiffFile[] = []
  for (const change of held.changes) {
    if (change.staged) {
      staged.add(change.path)
    }
    files.push(byPath.get(change.path) ?? blank(change.path))
    byPath.delete(change.path)
  }
  files.push(...byPath.values())
  return {
    ahead: held.ahead,
    behind: held.behind,
    branches: held.branches,
    detachedAt: held.detachedAt,
    files,
    head: held.branch,
    phase: 'ready',
    staged,
    stat: diffStatOf(files) ?? NOTHING,
    unstaged: diffStatOf(files.filter((file) => !staged.has(file.path))) ?? NOTHING,
    upstream: held.upstream,
  }
}
/* 清单上有、补丁里没有（纯模式变更）：这一行照旧在，只是没有行可画。 */
function blank(path: string): DiffFile {
  return { binary: false, path, rows: [], stat: NOTHING }
}
/* 推送不带说明；提交留空时按变更集自己生成一条 —— 确定性的，不牵进一次模型调用。 */
function subjectFor(intent: GitCommitIntent, message: string, reading: ReviewReading): string {
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
/* 显式列全字段：计算键会把类型放宽成索引签名。 */
function switched(held: ReviewPresentation, name: ReviewSwitch): ReviewPresentation {
  return {
    hideWhitespace: name === 'hideWhitespace' ? !held.hideWhitespace : held.hideWhitespace,
    wordDiff: name === 'wordDiff' ? !held.wordDiff : held.wordDiff,
    wrap: name === 'wrap' ? !held.wrap : held.wrap,
  }
}
