export type FileChangeKind = 'added' | 'modified' | 'deleted' | 'renamed' | 'copied' | 'untracked' | 'conflicted'

export interface PorcelainEntry {
  readonly kind: 'ordinary' | 'renamed' | 'unmerged' | 'untracked' | 'ignored'
  /** 暂存区状态字符（'.' 表示未改动）；untracked/ignored 为 '?' / '!' */
  readonly index: string
  readonly worktree: string
  readonly path: string
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

export function parsePorcelainV2(stdout: string): PorcelainStatus {
  const tokens = stdout.split('\0')
  const header: BranchHeader = { oid: null, head: null, upstream: null, ahead: 0, behind: 0 }
  const entries: PorcelainEntry[] = []
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!
    if (t === '') continue
    if (t.startsWith('# ')) {
      readBranchLine(header, t.slice(2))
      continue
    }
    const entry = entryOf(t, tokens[i + 1])
    if (entry === null) continue
    /* 重命名那条把旧路径放在下一个 token 里（-z 分段），吃掉它 */
    if (entry.kind === 'renamed') i++
    entries.push(entry)
  }
  return { ...header, entries }
}

interface BranchHeader {
  oid: string | null
  head: string | null
  upstream: string | null
  ahead: number
  behind: number
}

/** 一行 `# branch.xxx value`：认不出的键就不动（git 以后加新键也不会把解析打挂） */
function readBranchLine(header: BranchHeader, line: string): void {
  const [key, ...rest] = line.split(' ')
  const value = rest.join(' ')
  if (key === 'branch.oid') header.oid = value === '(initial)' ? null : value
  else if (key === 'branch.head') header.head = value === '(detached)' ? null : value
  else if (key === 'branch.upstream') header.upstream = value
  else if (key === 'branch.ab') {
    const [a, b] = value.split(' ')
    header.ahead = Number(a?.slice(1) ?? 0) || 0
    header.behind = Number(b?.slice(1) ?? 0) || 0
  }
}

/** 一条 porcelain 记录 → 条目；认不出的标记（新版本 git 可能加）返回 null */
function entryOf(line: string, next: string | undefined): PorcelainEntry | null {
  const index = line[2]!
  const worktree = line[3]!
  switch (line[0]) {
    case '1':
      return { kind: 'ordinary', index, worktree, path: afterFields(line, 8), oldPath: null }
    case '2':
      return { kind: 'renamed', index, worktree, path: afterFields(line, 9), oldPath: next ?? '' }
    case 'u':
      return { kind: 'unmerged', index, worktree, path: afterFields(line, 10), oldPath: null }
    case '?':
      return { kind: 'untracked', index: '?', worktree: '?', path: line.slice(2), oldPath: null }
    case '!':
      return { kind: 'ignored', index: '!', worktree: '!', path: line.slice(2), oldPath: null }
    default:
      return null
  }
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
 * 把条目分成「已暂存 / 未暂存」两组（review 的 GitStatus 直接使用）：ordinary/renamed 按 index 与 worktree 各出一条；
 * unmerged → 未暂存 conflicted；untracked → 未暂存 untracked；ignored 忽略。
 */
export function toChangeLists(entries: readonly PorcelainEntry[]): { staged: ChangeEntry[]; unstaged: ChangeEntry[] } {
  const staged: ChangeEntry[] = []
  const unstaged: ChangeEntry[] = []
  for (const e of entries) {
    if (e.kind === 'ordinary' || e.kind === 'renamed') {
      if (e.index !== '.') staged.push({ path: e.path, change: changeOf(e.index), oldPath: oldPathOf(e) })
      if (e.worktree !== '.') unstaged.push({ path: e.path, change: changeOf(e.worktree), oldPath: null })
      continue
    }
    const change = unstagedChangeOf(e)
    if (change !== null) unstaged.push({ path: e.path, change, oldPath: null })
  }
  return { staged, unstaged }
}

/** 重命名那一条的旧路径只在已暂存那一组里有意义（未暂存那组的旧路径归 git 自己管） */
function oldPathOf(entry: PorcelainEntry): string | null {
  return entry.kind === 'renamed' ? entry.oldPath : null
}

/** 只落未暂存一组的那几档：conflicted / untracked；ignored 与 ordinary 之外的不上屏 */
function unstagedChangeOf(entry: PorcelainEntry): FileChangeKind | null {
  if (entry.kind === 'unmerged') return 'conflicted'
  if (entry.kind === 'untracked') return 'untracked'
  return null
}

export interface NumstatEntry {
  readonly path: string
  readonly oldPath: string | null
  /** 二进制文件为 null */
  readonly additions: number | null
  readonly deletions: number | null
  readonly binary: boolean
}

/** 解析 `git diff --numstat -z …`。重命名记录为 `add\tdel\t\0old\0new\0`。 */
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

/** for-each-ref 的格式串：字段以 NUL 分隔，每个引用一行。与 parseForEachRef 配套使用。 */
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

export function parseNulList(stdout: string): string[] {
  return stdout.split('\0').filter((s) => s.length > 0)
}
