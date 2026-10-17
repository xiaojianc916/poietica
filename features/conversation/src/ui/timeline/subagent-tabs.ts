/**
 * 右坞「子代理」那一组的标签真相：按对话号记着开了哪些子代理、选中的是哪一个。不碰 React、不碰内核，所以能直接单测。
 *
 * 为什么按对话号分账：右坞本身就按归属（对话号）分账 —— 切到另一条对话，坞里是那一条的格；子代理标签跟着同一条规则走，
 * 不会出现「在 A 对话里看见 B 对话的子代理」。
 */

export interface SubagentTabSet {
  readonly ids: readonly string[]
  readonly activeId: string | null
}

type Listener = () => void

export class SubagentTabsStore {
  private readonly byThread = new Map<string, SubagentTabSet>()
  private readonly titles = new Map<string, string>()
  private readonly listeners = new Set<Listener>()

  /** 打开（去重）并选中；同一个子代理再点一次只是切过去。`title` 只在第一次给出时记下，之后的不覆盖。 */
  open(threadId: string, agentId: string, title?: string): void {
    const key = titleKey(threadId, agentId)
    if (title !== undefined && title !== '' && !this.titles.has(key)) {
      this.titles.set(key, title)
    }
    const current = this.byThread.get(threadId)
    const ids = current?.ids.includes(agentId) === true ? current.ids : [...(current?.ids ?? []), agentId]
    if (current !== undefined && current.ids === ids && current.activeId === agentId) {
      return
    }
    this.commit(threadId, { ids, activeId: agentId })
  }

  select(threadId: string, agentId: string): void {
    const current = this.byThread.get(threadId)
    if (current === undefined || !current.ids.includes(agentId) || current.activeId === agentId) {
      return
    }
    this.commit(threadId, { ids: current.ids, activeId: agentId })
  }

  /** 关一个标签；关的正是选中的那个时选中落到剩下的最后一个。交回这条对话还剩几个。 */
  close(threadId: string, agentId: string): number {
    const current = this.byThread.get(threadId)
    if (current === undefined || !current.ids.includes(agentId)) {
      return current?.ids.length ?? 0
    }
    const ids = current.ids.filter((id) => id !== agentId)
    const activeId = current.activeId === agentId ? (ids.at(-1) ?? null) : current.activeId
    this.titles.delete(titleKey(threadId, agentId))
    if (ids.length === 0) {
      this.byThread.delete(threadId)
      this.emit()
    } else {
      this.commit(threadId, { ids, activeId })
    }
    return ids.length
  }

  /** 对话被删 / 归档：它的标签一并作废。 */
  forget(threadId: string): void {
    if (!this.byThread.delete(threadId)) {
      return
    }
    for (const key of [...this.titles.keys()]) {
      if (key.startsWith(`${threadId}\u0000`)) this.titles.delete(key)
    }
    this.emit()
  }

  /** 引用随变更才换：可直接作 useSyncExternalStore 的快照。 */
  of(threadId: string | null): SubagentTabSet | null {
    return threadId === null ? null : (this.byThread.get(threadId) ?? null)
  }

  titleOf(threadId: string, agentId: string): string | undefined {
    return this.titles.get(titleKey(threadId, agentId))
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private commit(threadId: string, next: SubagentTabSet): void {
    this.byThread.set(threadId, next)
    this.emit()
  }

  private emit(): void {
    for (const listener of [...this.listeners]) listener()
  }
}

function titleKey(threadId: string, agentId: string): string {
  return `${threadId}\u0000${agentId}`
}
