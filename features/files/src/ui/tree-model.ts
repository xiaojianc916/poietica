import { type FileTreeRow, pathTreeRows } from '@poietica/design-system'
import type { FileEntry } from '../contract'
import type { FilesApi } from './api'

/*
 * 一个工作区的文件树：哪些目录展开着、各目录读到了什么、筛选词与结果。不碰 React：组件经 subscribe / version 订阅，
 * rows() 按版本记忆，一次变化只算一遍行。
 *
 * 懒加载：只读展开着的目录；文件变了（files.changed）只重读「读过的、且是变动路径父目录」的那几个。
 * 筛选走 Core 的 files.search（整个工作区，尊重 .gitignore），结果按路径集画成稀疏树（与审查的变更树同一份 pathTreeRows）。
 */

type DirState =
  | { readonly phase: 'loading' }
  | { readonly phase: 'ready'; readonly entries: readonly FileEntry[]; readonly truncated: boolean }
  | { readonly phase: 'failed' }

export type SearchState =
  | { readonly phase: 'idle' }
  | { readonly phase: 'searching' }
  | { readonly phase: 'ready'; readonly hits: readonly string[]; readonly truncated: boolean }
  | { readonly phase: 'failed' }

const SEARCH_DEBOUNCE_MS = 150

function parentOf(path: string): string {
  const at = path.lastIndexOf('/')
  return at < 0 ? '' : path.slice(0, at)
}

function rowOf(entry: FileEntry, depth: number, expanded: ReadonlySet<string>): FileTreeRow {
  const folder = entry.kind === 'directory'
  return {
    kind: folder ? 'folder' : 'file',
    key: entry.path,
    label: entry.name,
    depth,
    ...(folder ? { expanded: expanded.has(entry.path) } : {}),
    ...(entry.ignored ? { dimmed: true } : {}),
  }
}

function ancestorsOf(path: string): readonly string[] {
  const parts = path.split('/').slice(0, -1)
  return parts.map((_, index) => parts.slice(0, index + 1).join('/'))
}

export class FileTreeModel {
  private readonly dirs = new Map<string, DirState>()
  private readonly expanded = new Set<string>()
  /* 筛选结果里被人收起的目录（结果树默认全展开）。 */
  private readonly collapsedHits = new Set<string>()
  private readonly listeners = new Set<() => void>()
  private serial = 0
  private memo: { readonly at: number; readonly rows: readonly FileTreeRow[] } | null = null
  private query = ''
  private search: SearchState = { phase: 'idle' }
  private searchTimer: ReturnType<typeof setTimeout> | undefined
  private searchSerial = 0
  private revealing: string | null = null

  constructor(
    readonly workspaceId: string,
    private readonly api: Pick<FilesApi, 'list' | 'search'>,
    private readonly report: (what: string, cause: unknown) => void,
  ) {}

  /** 第一次显示时读根目录；读过就不重读。 */
  start(): void {
    if (!this.dirs.has('')) void this.load('')
  }

  version = (): number => this.serial

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  queryText(): string {
    return this.query
  }

  searchState(): SearchState {
    return this.search
  }

  rootState(): DirState['phase'] | 'idle' {
    return this.dirs.get('')?.phase ?? 'idle'
  }

  /** 有目录因为条目太多被截掉了：树下面要明说。 */
  anyTruncated(): boolean {
    for (const dir of this.dirs.values()) {
      if (dir.phase === 'ready' && dir.truncated) return true
    }
    return false
  }

  rows(): readonly FileTreeRow[] {
    if (this.memo?.at === this.serial) return this.memo.rows
    const rows = this.query.trim() === '' ? this.treeRows() : this.searchRows()
    this.memo = { at: this.serial, rows }
    return rows
  }

  toggle(row: FileTreeRow): void {
    if (this.query.trim() !== '') {
      if (!this.collapsedHits.delete(row.key)) this.collapsedHits.add(row.key)
      this.bump()
      return
    }
    if (this.expanded.delete(row.key)) {
      this.bump()
      return
    }
    this.expanded.add(row.key)
    this.bump()
    if (!this.dirs.has(row.key)) void this.load(row.key)
  }

  collapseAll(): void {
    this.expanded.clear()
    this.collapsedHits.clear()
    this.bump()
  }

  /**
   * 让一个条目在树里看得见：展开它的每一层祖先（缺的读进来），并清掉筛选；open 时连它自己（目录）也展开。
   * 树是虚拟化的，展开了它也未必在视口里：记一笔「要滚到它」，树画出这一行时滚过去、再经 revealed 销账。
   */
  reveal(path: string, open = false): void {
    if (this.query !== '') this.setQuery('')
    this.revealing = path === '' ? null : path
    for (const dir of open && path !== '' ? [...ancestorsOf(path), path] : ancestorsOf(path)) {
      this.expanded.add(dir)
      if (!this.dirs.has(dir)) void this.load(dir)
    }
    this.bump()
  }

  /** 还没滚到的那一条（树挂载晚于 reveal 时也接得住：正文里点目录，是先展开、再打开树格）。 */
  revealTarget(): string | null {
    return this.revealing
  }

  /** 树已经滚到了：销账。不通知 —— 没有哪一处画面跟着它变。 */
  revealed(path: string): void {
    if (this.revealing === path) this.revealing = null
  }

  setQuery(query: string): void {
    this.query = query
    this.collapsedHits.clear()
    this.schedule()
  }

  private schedule(): void {
    const query = this.query
    clearTimeout(this.searchTimer)
    this.searchSerial += 1
    if (query.trim() === '') {
      this.search = { phase: 'idle' }
      this.bump()
      return
    }
    /* 重筛（文件变了）时保留上一份结果，不闪一下「正在筛选」。 */
    if (this.search.phase !== 'ready') this.search = { phase: 'searching' }
    this.bump()
    const serial = this.searchSerial
    this.searchTimer = setTimeout(() => {
      void this.runSearch(query, serial)
    }, SEARCH_DEBOUNCE_MS)
  }

  /** 文件变了：读过的目录里受影响的那几个重读（paths 为 null 即全部）；筛选着就重筛一次。 */
  changed(paths: readonly string[] | null): void {
    const stale =
      paths === null
        ? [...this.dirs.keys()]
        : [...new Set(paths.flatMap((path) => [parentOf(path), path]))].filter((dir) => this.dirs.has(dir))
    for (const dir of stale) void this.load(dir)
    if (this.query.trim() !== '') this.schedule()
  }

  /** Core 重启（或整棵要重读）：已读的全部重读，展开状态留着。 */
  reload(): void {
    this.changed(null)
  }

  dispose(): void {
    clearTimeout(this.searchTimer)
    this.searchSerial += 1
    this.listeners.clear()
  }

  private async load(dir: string): Promise<void> {
    if (!this.dirs.has(dir)) {
      this.dirs.set(dir, { phase: 'loading' })
      this.bump()
    }
    try {
      const listing = await this.api.list(this.workspaceId, dir)
      this.dirs.set(dir, { phase: 'ready', entries: listing.entries, truncated: listing.truncated })
    } catch (cause: unknown) {
      this.report('list', cause)
      /* 子目录读不到（多半是刚被删、被改名）：从账上拿掉，父目录那次重读会把它从树里去掉；根读不到才画失败。 */
      if (dir === '') {
        this.dirs.set(dir, { phase: 'failed' })
      } else {
        this.dirs.delete(dir)
        this.expanded.delete(dir)
      }
    }
    this.bump()
  }

  private async runSearch(query: string, serial: number): Promise<void> {
    try {
      const found = await this.api.search(this.workspaceId, query)
      if (serial !== this.searchSerial) return
      this.search = { phase: 'ready', hits: found.hits, truncated: found.truncated }
    } catch (cause: unknown) {
      if (serial !== this.searchSerial) return
      this.report('search', cause)
      this.search = { phase: 'failed' }
    }
    this.bump()
  }

  private treeRows(): readonly FileTreeRow[] {
    const rows: FileTreeRow[] = []
    const walk = (dir: string, depth: number): void => {
      const state = this.dirs.get(dir)
      if (state?.phase !== 'ready') return
      for (const entry of state.entries) {
        const row = rowOf(entry, depth, this.expanded)
        rows.push(row)
        if (row.expanded === true) walk(entry.path, depth + 1)
      }
    }
    walk('', 0)
    return rows
  }

  private searchRows(): readonly FileTreeRow[] {
    if (this.search.phase !== 'ready') return []
    return pathTreeRows(this.search.hits, this.collapsedHits).map((row) =>
      row.kind === 'folder' ? { ...row, expanded: !this.collapsedHits.has(row.key) } : row,
    )
  }

  private bump(): void {
    this.serial += 1
    for (const listener of [...this.listeners]) listener()
  }
}
