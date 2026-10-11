/*
 * 最近被铺出来过的行，按 key 记、按最近使用淘汰。
 *
 * 虚拟器只铺视口 ± overscan：人向上滚过几屏再滚回来，刚才看过的行已经不在渲染集合里，
 * React 卸掉整棵子树，行内的 markdown 解析、KaTeX、Mermaid 图全部丢；回来时从头重算。
 * 「上去看一眼再回来」是最常见的操作，所以渲染集合 = 默认区间 ∪ 最近看过的 N 行。
 *
 * 按 key 不按下标：向上续读会在前面插行，下标整体位移，key 不变。有上限：Core 长期运行、
 * 对话可以很长，常驻集合只增不减就是 DOM 泄漏（AGENTS §8.4）。
 */
export type RowKey = string | number

export class KeepAlive {
  /** Map 的插入顺序就是使用顺序：刚 touch 的挪到末尾，淘汰从最前面取。 */
  readonly #order = new Map<RowKey, true>()

  constructor(readonly capacity: number) {}

  /** 这一批 key 刚被铺出来：挪到最近端，超出上限从最旧的删。 */
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

/**
 * 渲染集合 = 默认区间 ∪ 常驻行，升序去重。
 *
 * 两条纪律：
 *   • 升序：spansRef 上的二分（rowAtAnchor）与虚拟器自己的遍历都假定起点单调；
 *   • 越界丢掉：行号在两次铺出来之间会位移（向上续读），换算回来的未必还是同一格。
 */
export function mergeRange(
  base: readonly number[],
  keys: Iterable<RowKey>,
  rowOf: (key: string) => number | undefined,
  count: number,
): number[] {
  const chosen = new Set(base)

  for (const key of keys) {
    /* key 是 number 说明当时那一行还没有 id：那种行不常驻，重算也不贵。 */
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
