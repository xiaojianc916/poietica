/**
 * 右坞「文件」那一组的标签账：按归属（对话号）记着开了哪些文件、选中哪一个。不碰 React、不碰内核，能直接单测。
 *
 * 为什么按对话分账：右坞本身就按归属分账（layout.panes.byOwner），子代理标签也是这条规则 —— 切到另一条对话，
 * 坞里是那一条的文件，不会在 A 对话里看见 B 对话开的 a.ts。
 *
 * 标签号不用路径：路径里有空格、斜杠，标签号要进 DOM id（aria-controls 指的就是它）。同一个文件（工作区 + 路径）
 * 在所有归属里共用一个号；没有任何归属再引用它时号与文件记录一起删掉，两张表都不会只增不减。
 */

export interface FileTab {
  readonly id: string
  readonly workspaceId: string
  readonly path: string
}

export interface FileTabSet {
  readonly ids: readonly string[]
  readonly activeId: string | null
}

/** 打开时要滚到的那一行；seq 每次打开都变，同一行再点一次也会再滚一次。 */
export interface FileReveal {
  readonly line: number
  readonly column: number | null
  readonly seq: number
}

type Listener = () => void

function fileKey(workspaceId: string, path: string): string {
  return `${workspaceId}\u0000${path}`
}

function revealKey(owner: string, id: string): string {
  return `${owner}\u0000${id}`
}

export class FileTabsStore {
  private readonly byOwner = new Map<string, FileTabSet>()
  private readonly tabs = new Map<string, FileTab>()
  private readonly ids = new Map<string, string>()
  private readonly reveals = new Map<string, FileReveal>()
  private readonly listeners = new Set<Listener>()
  private serial = 0

  /** 打开（去重）并选中；带行号时记一次「滚到这一行」。交回标签号。 */
  open(
    owner: string,
    workspaceId: string,
    path: string,
    line: number | null = null,
    column: number | null = null,
  ): string {
    const id = this.idOf(workspaceId, path)
    const current = this.byOwner.get(owner)
    const ids = current?.ids.includes(id) === true ? current.ids : [...(current?.ids ?? []), id]
    if (line !== null) {
      this.serial += 1
      this.reveals.set(revealKey(owner, id), { line, column, seq: this.serial })
    }
    this.byOwner.set(owner, { ids, activeId: id })
    this.emit()
    return id
  }

  select(owner: string, id: string): void {
    const current = this.byOwner.get(owner)
    if (current === undefined || !current.ids.includes(id) || current.activeId === id) return
    this.byOwner.set(owner, { ids: current.ids, activeId: id })
    this.emit()
  }

  /** 关一个标签；关的正是选中的那个时选中落到剩下的最后一个。交回这位归属还剩几个。 */
  close(owner: string, id: string): number {
    const current = this.byOwner.get(owner)
    if (current === undefined || !current.ids.includes(id)) return current?.ids.length ?? 0
    const ids = current.ids.filter((held) => held !== id)
    this.reveals.delete(revealKey(owner, id))
    if (ids.length === 0) this.byOwner.delete(owner)
    else this.byOwner.set(owner, { ids, activeId: current.activeId === id ? (ids.at(-1) ?? null) : current.activeId })
    this.collect()
    this.emit()
    return ids.length
  }

  /** 归属消失（对话被删、坞那一份被遗忘）：它的标签一并作废。 */
  forget(owner: string): void {
    if (!this.byOwner.delete(owner)) return
    for (const key of [...this.reveals.keys()]) {
      if (key.startsWith(`${owner}\u0000`)) this.reveals.delete(key)
    }
    this.collect()
    this.emit()
  }

  /** 只留这些归属：布局那边已经不记得的归属，这里也不该再记着。 */
  retain(owners: ReadonlySet<string>): void {
    for (const owner of [...this.byOwner.keys()]) {
      if (!owners.has(owner)) this.forget(owner)
    }
  }

  /** 工作区被移除：所有归属里属于它的标签都关掉。 */
  forgetWorkspace(workspaceId: string): void {
    for (const tab of [...this.tabs.values()]) {
      if (tab.workspaceId !== workspaceId) continue
      for (const owner of [...this.byOwner.keys()]) this.close(owner, tab.id)
    }
  }

  /** 引用随变更才换：可直接作 useSyncExternalStore 的快照。 */
  of(owner: string | null): FileTabSet | null {
    return owner === null ? null : (this.byOwner.get(owner) ?? null)
  }

  tab(id: string): FileTab | undefined {
    return this.tabs.get(id)
  }

  revealOf(owner: string, id: string): FileReveal | undefined {
    return this.reveals.get(revealKey(owner, id))
  }

  /** 此刻有标签开着的工作区：监听集合要把它们算进去。 */
  workspaceIds(): ReadonlySet<string> {
    return new Set([...this.tabs.values()].map((tab) => tab.workspaceId))
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private idOf(workspaceId: string, path: string): string {
    const key = fileKey(workspaceId, path)
    const held = this.ids.get(key)
    if (held !== undefined) return held
    this.serial += 1
    const id = `file-${String(this.serial)}`
    this.ids.set(key, id)
    this.tabs.set(id, { id, workspaceId, path })
    return id
  }

  /* 没有任何归属再引用的文件：号与记录一起删。 */
  private collect(): void {
    const used = new Set<string>()
    for (const set of this.byOwner.values()) {
      for (const id of set.ids) used.add(id)
    }
    for (const [id, tab] of [...this.tabs]) {
      if (used.has(id)) continue
      this.tabs.delete(id)
      this.ids.delete(fileKey(tab.workspaceId, tab.path))
    }
  }

  private emit(): void {
    for (const listener of [...this.listeners]) listener()
  }
}
