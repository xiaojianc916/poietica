import type { GitCommitIntent, GitReview } from '@poietica/contract'
import { createExternalStore } from '@poietica/external-store'
import type { ReviewFailureReport, ReviewGateway } from './review-gateway'
import { type DiffFile, type DiffStat, diffStatOf, parseUnifiedPatch } from './unified-diff'

/*
 * 分隔条的交互态。领域不依赖表现层：这份联合与 design-system 的
 * RegionSplitter.SplitterActivity（packages/design-system/src/region-splitter.tsx）
 * 逐字相同 —— 正本在那里，这里注明；surfaces 的 review/ 把它的 onActivity 值原样递进来，
 * 结构化类型让两份同名同形联合天然相容。
 */
export type SplitterActivity = 'idle' | 'hover' | 'drag'
/*
 * 审查会话的唯一真相。
 *
 * 盘上的工作树是内容的真相；这个 store 是「这一格此刻在画什么」的真相：一份不可变
 * 快照、一个发布点。补丁原文只存一份，文件模型由它推出来 —— 呈现开关变了重推一次，
 * 不各存一份互相同步。不认识 DOM 与 React，所以能在 Node 里单独跑。
 */
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
  /** 提交说明与「包含未暂存」的选择：归 store，提交成功即被消费掉。 */
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
  /** 起一条「问一次、等一次」的循环，返回停止函数：谁创建谁销毁。 */
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
/** 默认基准：工作区对 HEAD —— git diff 不带 revision 时比的就是这一档。 */
export const WORKTREE_BASE = 'HEAD'
/** 文件树的宽度区间：分隔条与 store 的收敛读同一份。 */
export const TREE_MIN = 180
export const TREE_MAX = 480
/*
 * 一份补丁全文到着色行模型的整条推导：解析、词级差异、语法着色都是纯 CPU，
 * 在哪里跑由调用侧注入 —— surfaces 的 review/ 把它放进 Web Worker，主线程
 * 只收结果（opencode 的同款判决：重解析进 worker）。
 */
export type ReviewDerive = (patch: string, wordDiff: boolean) => Promise<readonly DiffFile[]>

export interface ReviewStoreOptions {
  readonly root: string
  readonly gateway: ReviewGateway
  readonly derive: ReviewDerive
  readonly report: ReviewFailureReport
}

export function createReviewStore(options: ReviewStoreOptions): ReviewStore {
  const { gateway, derive, report } = options
  const { root } = options
  let answer: GitReview | null = null
  let trouble: 'asking' | 'notARepository' | 'unreadable' = 'asking'
  let reading: ReviewReading = { phase: 'asking' }
  let presentation: ReviewPresentation = {
    hideWhitespace: false,
    wordDiff: true,
    wrap: false,
  }
  let base = WORKTREE_BASE
  let draft = ''
  let stageAll = true
  let query = ''
  let openFiles: ReadonlySet<string> = new Set<string>()
  let collapsedFolders: ReadonlySet<string> = new Set<string>()
  let openGaps: ReadonlySet<string> = new Set<string>()
  let treeOpen = true
  let treeWidth = 240
  let splitter: SplitterActivity = 'idle'
  let busy = false
  let stopped = false
  let looping = false
  /* 已取回全文并着色的路径与当前代：换一批文件模型就都作废。 */
  let enriched: ReadonlySet<string> = new Set<string>()
  let filling = false
  let generation = 0
  /* 清单解析按补丁原文去重：git 每跳一次就全量重解析一遍是白付的。 */
  let listing: { patch: string; files: readonly DiffFile[] } = { patch: '', files: [] }
  function read(): ReviewState {
    return {
      base,
      busy,
      collapsedFolders,
      draft,
      openFiles,
      openGaps,
      presentation,
      query,
      reading,
      splitter,
      stageAll,
      treeOpen,
      treeWidth,
    }
  }
  let snapshot = read()
  const store = createExternalStore<ReviewState>({ read: () => snapshot })
  function publish(): void {
    snapshot = read()
    store.notify()
  }
  function project(): void {
    generation += 1
    enriched = new Set<string>()
    /* 词级强调随整份文件按文件算：清单这一遍只要行与徽章。 */
    if (answer !== null && answer.patch !== listing.patch) {
      listing = { files: parseUnifiedPatch(answer.patch, false), patch: answer.patch }
    }
    reading = answer === null ? { phase: trouble } : ready(answer, listing.files)
    enrich()
  }
  /*
   * 开着的那几份才取全文、算词级差异、着色：清单每跳一次只带回三行上下文，画面上
   * 要折叠带与颜色的只有开着的几份。一次一份地取，天然排队；属于过期那一代的回答丢掉。
   */
  function enrich(): void {
    if (filling) {
      return
    }
    filling = true
    void (async () => {
      while (!stopped) {
        const wanted = pending()
        if (wanted === undefined) {
          break
        }
        const mine = generation
        enriched = new Set(enriched).add(wanted.path)
        const whole = await widened(wanted)
        const held = reading
        if (whole === null || stopped || mine !== generation || held.phase !== 'ready') {
          continue
        }
        reading = {
          ...held,
          files: held.files.map((file) => (file.path === whole.path ? whole : file)),
        }
        publish()
      }
      filling = false
    })()
  }
  function pending(): DiffFile | undefined {
    if (reading.phase !== 'ready') {
      return undefined
    }
    return reading.files.find(
      (file) => openFiles.has(file.path) && !file.binary && !enriched.has(file.path),
    )
  }
  /* 取不回来就照旧画三行上下文那一份：下一次 git 跳动会重问，这里不空转重试。 */
  async function widened(file: DiffFile): Promise<DiffFile | null> {
    try {
      const patch = await gateway.filePatch(root, base, file.path, presentation.hideWhitespace)
      const found = (await derive(patch, presentation.wordDiff)).find(
        (held) => held.path === file.path,
      )
      return found ?? file
    } catch (cause: unknown) {
      report('GIT_CHANGES_UNREADABLE', { cause })
      return null
    }
  }
  function mutate(change: () => void): void {
    change()
    publish()
  }
  async function load(): Promise<void> {
    try {
      const held = await gateway.review(root, base, TIGHT, presentation.hideWhitespace)
      if (stopped) {
        return
      }
      answer = held
      trouble = held === null ? 'notARepository' : 'asking'
    } catch (cause: unknown) {
      if (stopped) {
        return
      }
      report('GIT_CHANGES_UNREADABLE', { cause })
      answer = null
      trouble = 'unreadable'
    }
    project()
    publish()
  }
  /* 监视挂不上就没有下一次问，所以「刷新」能把这条循环接回来 —— 同一条，不是第二条。 */
  function loop(): void {
    if (looping) {
      return
    }
    looping = true
    void (async () => {
      while (!stopped) {
        await load()
        if (stopped) {
          break
        }
        try {
          await gateway.awaitChange(root)
        } catch (cause: unknown) {
          if (!stopped) {
            report('GIT_CHANGES_UNREADABLE', { cause })
          }
          break
        }
      }
      looping = false
    })()
  }
  return {
    applyCommand: () =>
      answer === null || answer.patch === '' ? '' : APPLY_HEAD + answer.patch + APPLY_TAIL,
    commit: (intent) => {
      if (busy) {
        return
      }
      busy = true
      publish()
      void gateway
        .commit({
          base,
          context: TIGHT,
          ignoreWhitespace: presentation.hideWhitespace,
          intent,
          message: subjectFor(intent, draft, reading),
          root,
          stageAll,
        })
        .then(
          (held) => {
            answer = held
            trouble = 'asking'
            /* 说明随这次提交一起被消费；推送不带说明，失败时草稿留着不用重打。 */
            if (intent !== 'push') {
              draft = ''
            }
          },
          (cause: unknown) => {
            report('GIT_REVIEW_ACTION_FAILED', { cause })
          },
        )
        .finally(() => {
          busy = false
          project()
          publish()
        })
    },
    getSnapshot: () => snapshot,
    /* 树里点一行就是把这一格打开；已经开着就什么都不做。 */
    openFile: (held) => {
      if (openFiles.has(held)) {
        return
      }
      mutate(() => {
        openFiles = new Set(openFiles).add(held)
      })
      enrich()
    },
    refresh: () => {
      if (looping) {
        void load()
        return
      }
      loop()
    },
    setAllOpen: (all) => {
      mutate(() => {
        openFiles =
          all && reading.phase === 'ready'
            ? new Set(reading.files.map((file) => file.path))
            : new Set<string>()
      })
      enrich()
    },
    setBase: (ref) => {
      if (ref === base) {
        return
      }
      base = ref
      void load()
      publish()
    },
    setDraft: (value) => {
      mutate(() => {
        draft = value
      })
    },
    setQuery: (value) => {
      mutate(() => {
        query = value
      })
    },
    setSplitter: (activity) => {
      if (activity === splitter) {
        return
      }
      mutate(() => {
        splitter = activity
      })
    },
    setStageAll: (on) => {
      mutate(() => {
        stageAll = on
      })
    },
    setTreeWidth: (width) => {
      const next = Math.max(TREE_MIN, Math.min(TREE_MAX, Math.round(width)))
      if (next === treeWidth) {
        return
      }
      mutate(() => {
        treeWidth = next
      })
    },
    start: () => {
      stopped = false
      loop()
      return () => {
        stopped = true
      }
    },
    subscribe: store.subscribe,
    toggleFile: (held) => {
      mutate(() => {
        openFiles = flipped(openFiles, held)
      })
      enrich()
    },
    toggleFolder: (key) => {
      mutate(() => {
        collapsedFolders = flipped(collapsedFolders, key)
      })
    },
    toggleGap: (key) => {
      mutate(() => {
        openGaps = flipped(openGaps, key)
      })
    },
    toggleSwitch: (name) => {
      presentation = switched(presentation, name)
      if (name === 'hideWhitespace') {
        void load()
      } else {
        project()
      }
      publish()
    },
    toggleTree: () => {
      mutate(() => {
        treeOpen = !treeOpen
        /* 筛选框随树一起消失：筛选条件不许留在看不见的地方继续生效。 */
        if (!treeOpen) {
          query = ''
        }
      })
    },
  }
}
const NOTHING: DiffStat = { added: 0, removed: 0 }
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
