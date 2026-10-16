/*
 * 最近被铺出来过的行：虚拟器只铺视口 ± overscan，人向上滚过几屏再滚回来时 React 已卸掉整棵子树，行内的 markdown、KaTeX、Mermaid 全部从头重算。按 key 不按下标（向上续读会插行），上限防止只增不减成为 DOM 泄漏（AGENTS §8.4）。
 */
export type RowKey = string | number

export class KeepAlive {
  readonly #order = new Map<RowKey, true>()

  constructor(readonly capacity: number) {}

  touch(keys: Iterable<RowKey>): void {
    for (const key of keys) {
      this.#order.delete(key)
      this.#order.set(key, true)
    }

    while (this.#order.size > this.capacity) {
      const oldest = this.#order.keys().next()

      if (oldest.done === true) {
        break
      }

      this.#order.delete(oldest.value)
    }
  }

  keys(): IterableIterator<RowKey> {
    return this.#order.keys()
  }

  get size(): number {
    return this.#order.size
  }
}

/** 升序是纪律：spansRef 上的二分与虚拟器都假定起点单调。越界的丢掉，因为向上续读会插行、行号位移。 */
export function mergeRange(
  base: readonly number[],
  keys: Iterable<RowKey>,
  rowOf: (key: string) => number | undefined,
  count: number,
): number[] {
  const chosen = new Set(base)

  for (const key of keys) {
    /* number key 说明那一行当时还没有 id：不常驻，重算也不贵。 */
    if (typeof key !== 'string') {
      continue
    }

    const at = rowOf(key)

    if (at !== undefined && at < count) {
      chosen.add(at)
    }
  }

  return [...chosen].sort((left, right) => left - right)
}
