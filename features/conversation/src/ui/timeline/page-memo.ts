import type { TurnPage } from './timeline-contract'

/**
 * `sealed` 里的页不可变、身份稳定，于是「扫一遍这一页」的结果跟着页走，长对话里每批就只剩在跑的那一页要现扫。
 * 只给 `sealed` 用：`active` 每批都是新对象，记它只会白填 WeakMap；WeakMap 随页回收，不需要删除路径（AGENTS §8.4）。
 */
export function sealedPageMemo<T extends object | null>(compute: (page: TurnPage) => T): (page: TurnPage) => T {
  const held = new WeakMap<TurnPage, { readonly value: T }>()
  return (page) => {
    const kept = held.get(page)
    if (kept !== undefined) {
      return kept.value
    }
    const value = compute(page)
    held.set(page, { value })
    return value
  }
}
