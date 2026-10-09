export type FileChangeKind = 'added' | 'modified' | 'deleted' | 'renamed' | 'copied' | 'untracked' | 'conflicted'

export interface PorcelainEntry {
  readonly kind: 'ordinary' | 'renamed' | 'unmerged' | 'untracked' | 'ignored'
  /** 暂存区状态字符（'.' 表示未改动）；untracked/ignored 为 '?' / '!' */
  readonly index: string
  /** 工作树状态字符 */
  readonly worktree: string
  readonly path: string
  /** 只有 renamed（含复制）有值 */
  readonly oldPath: string | null
}

export interface PorcelainStatus {
  /** HEAD 提交号；新仓库（还没有提交）为 null */
  readonly oid: string | null
  /** 当前分支名；HEAD 分离时为 null */
  readonly head: string | null
  readonly upstream: string | null
  readonly ahead: number
  readonly behind: number
  readonly entries: readonly PorcelainEntry[]
}

/** 取第 n 个空格之后的全部内容（路径可能含空格，所以不能简单 split） */
function afterFields(record: string, n: number): string {
  let at = 0
  for (let i = 0; i < n; i++) {
    at = record.indexOf(' ', at) + 1
    if (at === 0) return ''
  }
  return record.slice(at)
}

/** 解析 `git status --porcelain=v2 --branch -z` 的输出 */
export function parsePorcelainV2(stdout: string): PorcelainStatus {
  const tokens = stdout.split('\0')
  let oid: string | null = null
  let head: string | null = null
  let upstream: string | null = null
  let ahead = 0
  let behind = 0
  const entries: PorcelainEntry[] = []
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!
    if (t === '') continue
    if (t.startsWith('# ')) {
      const [key, ...rest] = t.slice(2).split(' ')
      const value = rest.join(' ')
      if (key === 'branch.oid') oid = value === '(initial)' ? null : value
      else if (key === 'branch.head') head = value === '(detached)' ? null : value
      else if (key === 'branch.upstream') upstream = value
      else if (key === 'branch.ab') {
        const [a, b] = value.split(' ')
        ahead = Number(a?.slice(1) ?? 0) || 0
        behind = Number(b?.slice(1) ?? 0) || 0
      }
      continue
    }
    const marker = t[0]
    if (marker === '1') {
      entries.push({ kind: 'ordinary', index: t[2]!, worktree: t[3]!, path: afterFields(t, 8), oldPath: null })
    } else if (marker === '2') {
      const oldPath = tokens[i + 1] ?? ''
      i++
      entries.push({ kind: 'renamed', index: t[2]!, worktree: t[3]!, path: afterFields(t, 9), oldPath })
    } else if (marker === 'u') {
      entries.push({ kind: 'unmerged', index: t[2]!, worktree: t[3]!, path: afterFields(t, 10), oldPath: null })
    } else if (marker === '?') {
      entries.push({ kind: 'untracked', index: '?', worktree: '?', path: t.slice(2), oldPath: null })
    } else if (marker === '!') {
      entries.push({ kind: 'ignored', index: '!', worktree: '!', path: t.slice(2), oldPath: null })
    }
  }
  return { oid, head, upstream, ahead, behind, entries }
}

export interface ChangeEntry {
  readonly path: string
  readonly change: FileChangeKind
  readonly oldPath: string | null
}

function changeOf(code: string): FileChangeKind {
  switch (code) {
    case 'A':
      return 'added'
    case 'D':
      return 'deleted'
    case 'R':
      return 'renamed'
    case 'C':
      return 'copied'
    default:
      return 'modified' // M、T 以及未来可能出现的其它字符
  }
}

/**
 * 把条目分成“已暂存 / 未暂存”两组（review 的 GitStatus 直接使用）：
 * ordinary/renamed：index≠'.' → 已暂存一条（renamed 带 oldPath）；worktree≠'.' → 未暂存一条。
 * unmerged → 未暂存 conflicted；untracked → 未暂存 untracked；ignored 忽略。
 */
export function toChangeLists(entries: readonly PorcelainEntry[]): { staged: ChangeEntry[]; unstaged: ChangeEntry[] } {
  const staged: ChangeEntry[] = []
  const unstaged: ChangeEntry[] = []
  for (const e of entries) {
    if (e.kind === 'ordinary' || e.kind === 'renamed') {
      if (e.index !== '.')
        staged.push({ path: e.path, change: changeOf(e.index), oldPath: e.kind === 'renamed' ? e.oldPath : null })
      if (e.worktree !== '.') unstaged.push({ path: e.path, change: changeOf(e.worktree), oldPath: null })
    } else if (e.kind === 'unmerged') {
      unstaged.push({ path: e.path, change: 'conflicted', oldPath: null })
    } else if (e.kind === 'untracked') {
      unstaged.push({ path: e.path, change: 'untracked', oldPath: null })
    }
  }
  return { staged, unstaged }
}

export interface NumstatEntry {
  readonly path: string
  readonly oldPath: string | null
  /** 二进制文件为 null */
  readonly additions: number | null
  readonly deletions: number | null
  readonly binary: boolean
}

/** 解析 `git diff --numstat -z …`。重命名记录为 `add\tdel\t\0old\0new\0` */
export function parseNumstat(stdout: string): NumstatEntry[] {
  const tokens = stdout.split('\0')
  const out: NumstatEntry[] = []
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!
    if (t === '') continue
    const [add, del, path] = t.split('\t') as [string, string, string | undefined]
    const binary = add === '-' && del === '-'
    const additions = binary ? null : Number(add)
    const deletions = binary ? null : Number(del)
    if (path === undefined || path === '') {
      const oldPath = tokens[i + 1] ?? ''
      const newPath = tokens[i + 2] ?? ''
      i += 2
      out.push({ path: newPath, oldPath, additions, deletions, binary })
    } else {
      out.push({ path, oldPath: null, additions, deletions, binary })
    }
  }
  return out
}

export interface NameStatusEntry {
  /** A/M/D/R/C/T/U 等单个字符 */
  readonly status: string
  readonly path: string
  readonly oldPath: string | null
  /** R/C 的相似度（0–100），其它为 null */
  readonly score: number | null
}

/** 解析 `git diff --name-status -z …`。R/C 记录为 `R100\0old\0new\0` */
export function parseNameStatus(stdout: string): NameStatusEntry[] {
  const tokens = stdout.split('\0')
  const out: NameStatusEntry[] = []
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!
    if (t === '') continue
    const status = t[0]!
    if (status === 'R' || status === 'C') {
      out.push({ status, oldPath: tokens[i + 1] ?? '', path: tokens[i + 2] ?? '', score: Number(t.slice(1)) || 0 })
      i += 2
    } else {
      out.push({ status, path: tokens[i + 1] ?? '', oldPath: null, score: null })
      i += 1
    }
  }
  return out
}

/** for-each-ref 的格式串（字段以 NUL 分隔，每个引用一行）。与 parseForEachRef 配套使用 */
export const BRANCH_FORMAT = '%(refname:short)%00%(upstream:short)%00%(committerdate:unix)%00%(HEAD)'

export interface BranchEntry {
  readonly name: string
  readonly upstream: string | null
  /** 最后一次提交时间（Unix 毫秒）；无法解析时为 null */
  readonly lastCommitAt: number | null
  readonly isCurrent: boolean
}

export function parseForEachRef(stdout: string): BranchEntry[] {
  return stdout
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => {
      const [name = '', upstream = '', date = '', head = ''] = line.split('\0')
      const seconds = Number(date)
      return {
        name,
        upstream: upstream === '' ? null : upstream,
        lastCommitAt: date !== '' && Number.isFinite(seconds) ? seconds * 1000 : null,
        isCurrent: head === '*',
      }
    })
}

/** 解析以 NUL 分隔的路径列表（`ls-files -z` 等） */
export function parseNulList(stdout: string): string[] {
  return stdout.split('\0').filter((s) => s.length > 0)
}
