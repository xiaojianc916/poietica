/**
 * 有序表上取「最后一个不晚于 x 的元素」。升序是构造保证（虚拟器按序号交出区间表），前提不成立时不做防御 —— 防御只会把破坏前提的调用变成静默的错答案。
 * 取不到元素时往左收，不中断：往左收只会少认一格，不会认错一格。返回下标而不是元素，两个调用方因此各取所需。
 */
export function lastAtOrBefore<T>(items: readonly T[], keyOf: (item: T) => number, at: number): number {
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
