import { AppError, type Disposable, SystemErrorCode } from '@poietica/foundation'

export interface ContributionPoint<T> {
  readonly id: string
  readonly __type?: T
}

/** 内置贡献点 id 以 'workbench.' 开头；功能自定义贡献点 id 以 '<功能 id>.' 开头，例如 'conversation.toolCallRenderers' */
export function defineContributionPoint<T>(id: string): ContributionPoint<T> {
  return Object.freeze({ id })
}

export interface Contributed<T> {
  readonly featureId: string
  readonly item: T
}

interface Entry {
  readonly featureId: string
  readonly item: unknown
  readonly seq: number
}

export class ContributionRegistry {
  private readonly entries = new Map<string, Entry[]>()
  private readonly cache = new Map<string, readonly Contributed<unknown>[]>()
  private readonly listeners = new Map<string, Set<() => void>>()
  private seq = 0

  add<T>(point: ContributionPoint<T>, featureId: string, item: T): Disposable {
    const list = this.entries.get(point.id) ?? []
    const id = (item as { id?: unknown }).id
    if (typeof id === 'string' && list.some((e) => (e.item as { id?: unknown }).id === id)) {
      const other = list.find((e) => (e.item as { id?: unknown }).id === id)!.featureId
      throw new AppError(
        SystemErrorCode.conflict,
        `贡献点 ${point.id} 中 id=${id} 的条目同时由 ${other} 与 ${featureId} 注册`,
      )
    }
    const entry: Entry = { featureId, item, seq: this.seq++ }
    this.entries.set(point.id, [...list, entry])
    this.changed(point.id)
    return {
      dispose: () => {
        this.entries.set(
          point.id,
          (this.entries.get(point.id) ?? []).filter((e) => e !== entry),
        )
        this.changed(point.id)
      },
    }
  }

  /** 按 item.order 升序（缺省 0），同 order 按注册先后；返回的数组在下一次变化之前保持同一引用 */
  list<T>(point: ContributionPoint<T>): readonly Contributed<T>[] {
    const cached = this.cache.get(point.id)
    if (cached !== undefined) return cached as readonly Contributed<T>[]
    const order = (e: Entry): number => {
      const o = (e.item as { order?: unknown }).order
      return typeof o === 'number' ? o : 0
    }
    const sorted = [...(this.entries.get(point.id) ?? [])]
      .sort((a, b) => order(a) - order(b) || a.seq - b.seq)
      .map((e) => Object.freeze({ featureId: e.featureId, item: e.item as T }))
    this.cache.set(point.id, sorted)
    return sorted
  }

  /** 某功能贡献的全部条目（诊断/测试用） */
  featureIds(): readonly string[] {
    const ids = new Set<string>()
    for (const list of this.entries.values()) for (const e of list) ids.add(e.featureId)
    return [...ids]
  }

  subscribe(point: ContributionPoint<unknown>, listener: () => void): () => void {
    const set = this.listeners.get(point.id) ?? new Set()
    this.listeners.set(point.id, set)
    set.add(listener)
    return () => {
      set.delete(listener)
    }
  }

  private changed(pointId: string): void {
    this.cache.delete(pointId)
    for (const l of [...(this.listeners.get(pointId) ?? [])]) l()
  }
}
