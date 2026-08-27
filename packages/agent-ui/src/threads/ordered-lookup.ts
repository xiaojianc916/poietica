/**
 * 有序表上取「最后一个不晚于 x 的元素」。
 *
 * 升序是构造保证：虚拟器按序号交出区间表。前提不成立时这里不做防御 —— 防御只会
 * 把破坏前提的调用变成一个静默的错答案。
 *
 * 取不到元素时往左收，不中断：noUncheckedIndexedAccess 下这一格必须判，而中断
 * 会带着半截 found 出去，那正是上一句要避免的静默错答案。往左收只会少认一格，
 * 不会认错一格。
 *
 * 返回下标而不是元素：两个调用方要的东西不同，一个要 span.index，一个要序号
 * 本身。返回下标让它们各取所需，而不必在这里塞一个联合返回类型。
 */
export function lastAtOrBefore<T>(
  items: readonly T[],
  keyOf: (item: T) => number,
  at: number,
): number {
  let low = 0
  let high = items.length - 1
  let found = -1

  while (low <= high) {
    const middle = (low + high) >>> 1
    const item = items[middle]

    if (item !== undefined && keyOf(item) <= at) {
      found = middle
      low = middle + 1
    } else {
      high = middle - 1
    }
  }

  return found
}
