/**
 * 有序表上取「最后一个不晚于 x 的元素」。
 *
 * 这条判据的两半曾各写一份：feed/reading-position.ts 的 rowAtAnchor 与本文件的
 * turnIndexAtRow，循环体、收敛条件、undefined 的处理逐字相同，差别只有 >> 与
 * >>>，以及空表时一个返回 null 一个返回 0。一条判据两个实现，就是两个可以各自
 * 改错的地方 —— 循环体只在这里写一次，两半各留自己的包装。
 *
 * 升序是构造保证：虚拟器按序号交出区间表，buildTurns 按先后推入轮次。前提
 * 不成立时这里不做防御 —— 防御只会把破坏前提的调用变成一个静默的错答案。
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

/** 判据用得到的全部：一轮从哪一行开始。 */
export interface TurnAnchor {
  readonly rowIndex: number
}

/**
 * 正在读的是第几轮。
 *
 * 空表返回 0：没有轮次时调用方根本不挂载导航，这个分支只是让返回类型保持是
 * number，而不是把空态推给上层再判一次。
 */
export function turnIndexAtRow(turns: readonly TurnAnchor[], rowIndex: number): number {
  return Math.max(
    0,
    lastAtOrBefore(turns, (turn) => turn.rowIndex, rowIndex),
  )
}
