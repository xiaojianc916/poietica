import type { TurnPage } from './timeline-contract'

/**
 * 已封口页上的派生，按页对象身份只算一次（性能审查 P-04）。
 *
 * 为什么记得住：`sealed` 里的页不可变、身份稳定 —— 投影层按 turn 对象身份复用页
 * （transcript-projector 的 TURN_PROJECTIONS / WRAPPED_PAGES），没动过的页每批交回的都是
 * 同一个对象。于是「扫一遍这一页」的结果跟着页走，长对话里每批就只剩在跑的那一页要现扫。
 *
 * 只给 `sealed` 里的页用：`active` 每批都是新对象，记它只会白填 WeakMap。
 * WeakMap 随页回收，不是按线程索引的表，不需要删除路径（AGENTS §8.4）。
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
