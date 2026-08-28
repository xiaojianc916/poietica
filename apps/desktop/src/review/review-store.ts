import { createExternalStore } from '@poietica/core'
import {
  type GitFileChange,
  type GitReview,
  gitAwaitChange,
  gitCommitOrPush,
  gitReview,
} from '@poietica/ipc'
import { reportFailure } from '../failures/application-policy'
import { type ReviewFile, reviewFiles } from './unified-diff'
/*
 * 审查会话的唯一真相。
 *
 * 盘上的工作树是内容的真相；这个 store 是「这一格此刻在画什么」的真相：一份不可变
 * 快照、一个发布点。补丁原文只存一份，文件模型由它推出来 —— 呈现开关变了重推一次，
 * 不各存一份互相同步。不认识 DOM 与 React，所以能在 Node 里单独跑。
 */
export type ChangeStatus = GitFileChange['status']
/** 影响 git 问法的开关要重问，只影响推导的重推即可 —— 两组分开，不白跑进程往返。 */
export interface ReviewPresentation {
  readonly wrap: boolean
  readonly tightContext: boolean
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
      readonly files: readonly ReviewFile[]
      readonly statuses: ReadonlyMap<string, ChangeStatus>
      readonly staged: ReadonlySet<string>
      readonly additions: number
      readonly deletions: number
    }
export interface ReviewState {
  readonly reading: ReviewReading
  readonly presentation: ReviewPresentation
  readonly base: string
  readonly query: string
  readonly folded: ReadonlySet<string>
  readonly openGaps: ReadonlySet<string>
  /** 路径 → 当时的内容指纹。文件再变一次，指纹对不上，标记自己失效。 */
  readonly viewed: ReadonlyMap<string, string>
  readonly filesOpen: boolean
  readonly busy: boolean
}
export interface ReviewStore {
  readonly subscribe: (listen: () => void) => () => void
  readonly getSnapshot: () => ReviewState
  /** 起一条「问一次、等一次」的循环，返回停止函数：谁创建谁销毁。 */
  readonly start: () => () => void
  readonly setQuery: (value: string) => void
  readonly setBase: (ref: string) => void
  readonly toggleFold: (path: string) => void
  readonly setAllFolded: (folded: boolean) => void
  readonly toggleGap: (key: string) => void
  readonly toggleSwitch: (name: ReviewSwitch) => void
  readonly toggleFiles: () => void
  readonly setViewed: (path: string, viewed: boolean) => void
  readonly refresh: () => void
  readonly commitOrPush: (message: string) => void
  readonly applyCommand: () => string
}
const TIGHT = 3
/* 不折上限：一次把整份文件取回来，折叠带上的行数才是真数字而不是估计。 */
const WHOLE = 100_000
const APPLY_HEAD = "git apply --3way - <<'PATCH'\\n"
const APPLY_TAIL = '\\nPATCH\\n'
export function createReviewStore(root: string): ReviewStore {
  let answer: GitReview | null = null
  let trouble: 'asking' | 'notARepository' | 'unreadable' = 'asking'
  let reading: ReviewReading = { phase: 'asking' }
  let presentation: ReviewPresentation = {
    hideWhitespace: false,
    tightContext: false,
    wordDiff: true,
    wrap: false,
  }
  let base = 'HEAD'
  let query = ''
  let folded: ReadonlySet<string> = new Set<string>()
  let openGaps: ReadonlySet<string> = new Set<string>()
  let viewed: ReadonlyMap<string, string> = new Map<string, string>()
  let filesOpen = true
  let busy = false
  let stopped = false
  function read(): ReviewState {
    return { base, busy, filesOpen, folded, openGaps, presentation, query, reading, viewed }
  }
  let snapshot = read()
  const store = createExternalStore<ReviewState>({ read: () => snapshot })
  function publish(): void {
    snapshot = read()
    store.notify()
  }
  function project(): void {
    reading = answer === null ? { phase: trouble } : ready(answer, presentation.wordDiff)
  }
  function mutate(change: () => void): void {
    change()
    publish()
  }
  async function load(): Promise<void> {
    try {
      const held = await gitReview(
        root,
        base,
        presentation.tightContext ? TIGHT : WHOLE,
        presentation.hideWhitespace,
      )
      if (stopped) {
        return
      }
      answer = held
      trouble = held === null ? 'notARepository' : 'asking'
    } catch (cause: unknown) {
      if (stopped) {
        return
      }
      reportFailure('GIT_CHANGES_UNREADABLE', { cause, scope: 'review' })
      answer = null
      trouble = 'unreadable'
    }
    project()
    publish()
  }
  return {
    applyCommand: () =>
      answer === null || answer.patch === '' ? '' : APPLY_HEAD + answer.patch + APPLY_TAIL,
    commitOrPush: (message) => {
      if (busy) {
        return
      }
      busy = true
      publish()
      void gitCommitOrPush(
        root,
        message,
        base,
        presentation.tightContext ? TIGHT : WHOLE,
        presentation.hideWhitespace,
      )
        .then(
          (held) => {
            answer = held
            trouble = 'asking'
          },
          (cause: unknown) => {
            reportFailure('GIT_REVIEW_ACTION_FAILED', { cause, scope: 'review' })
          },
        )
        .finally(() => {
          busy = false
          project()
          publish()
        })
    },
    getSnapshot: () => snapshot,
    refresh: () => {
      void load()
    },
    setAllFolded: (all) => {
      mutate(() => {
        folded =
          all && reading.phase === 'ready'
            ? new Set(reading.files.map((file) => file.path))
            : new Set<string>()
      })
    },
    setBase: (ref) => {
      if (ref === base) {
        return
      }
      base = ref
      void load()
      publish()
    },
    setQuery: (value) => {
      mutate(() => {
        query = value
      })
    },
    setViewed: (path, seen) => {
      mutate(() => {
        const next = new Map(viewed)
        const file =
          reading.phase === 'ready' ? reading.files.find((held) => held.path === path) : undefined
        if (seen && file !== undefined) {
          next.set(path, file.digest)
        } else {
          next.delete(path)
        }
        viewed = next
      })
    },
    start: () => {
      stopped = false
      void (async () => {
        while (!stopped) {
          await load()
          if (stopped) {
            return
          }
          try {
            await gitAwaitChange(root)
          } catch (cause: unknown) {
            /* 挂不上表就没有下一次问：说一次然后停 —— 不退化成静默轮询。 */
            if (!stopped) {
              reportFailure('GIT_CHANGES_UNREADABLE', { cause, scope: 'review' })
            }
            return
          }
        }
      })()
      return () => {
        stopped = true
      }
    },
    subscribe: store.subscribe,
    toggleFiles: () => {
      mutate(() => {
        filesOpen = !filesOpen
      })
    },
    toggleFold: (path) => {
      mutate(() => {
        folded = flipped(folded, path)
      })
    },
    toggleGap: (key) => {
      mutate(() => {
        openGaps = flipped(openGaps, key)
      })
    },
    toggleSwitch: (name) => {
      presentation = switched(presentation, name)
      if (name === 'tightContext' || name === 'hideWhitespace') {
        void load()
      } else {
        project()
      }
      publish()
    },
  }
}
/* 清单是权威顺序，补丁按路径对上去；补丁里有而清单里没有的照实附在后面。 */
function ready(held: GitReview, wordDiff: boolean): ReviewReading {
  const byPath = new Map(
    reviewFiles(held.patch, wordDiff).map((file) => [file.path, file] as const),
  )
  const statuses = new Map<string, ChangeStatus>()
  const staged = new Set<string>()
  const files: ReviewFile[] = []
  let additions = 0
  let deletions = 0
  for (const change of held.changes) {
    statuses.set(change.path, change.status)
    if (change.staged) {
      staged.add(change.path)
    }
    files.push(byPath.get(change.path) ?? blank(change.path))
    byPath.delete(change.path)
  }
  files.push(...byPath.values())
  for (const file of files) {
    additions += file.additions
    deletions += file.deletions
  }
  return {
    additions,
    ahead: held.ahead,
    behind: held.behind,
    branches: held.branches,
    deletions,
    detachedAt: held.detachedAt,
    files,
    head: held.branch,
    phase: 'ready',
    staged,
    statuses,
    upstream: held.upstream,
  }
}
/* 清单上有、补丁里没有（二进制、纯模式变更）：这一行照旧在，只是没有行可画。 */
function blank(path: string): ReviewFile {
  return { additions: 0, bands: [], binary: false, deletions: 0, digest: '', patch: '', path }
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
    tightContext: name === 'tightContext' ? !held.tightContext : held.tightContext,
    wordDiff: name === 'wordDiff' ? !held.wordDiff : held.wordDiff,
    wrap: name === 'wrap' ? !held.wrap : held.wrap,
  }
}
