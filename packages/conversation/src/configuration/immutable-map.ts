/**
 * 改一格，交回一张新表；没真的变就原样交回旧的。
 *
 * 两个 store 都按不可变快照记状态，于是它们都需要这两句。此前它们是 ThreadsStore
 * 的私有方法，把会话那一侧拆出去时，最省事的做法是照抄一份过去 —— 同一个判据两处
 * 实现，正是这一刀要消灭的东西。
 *
 * 引用判等是它们存在的全部理由：没变就不换引用，上层的 Object.is 因此能挡住一整棵
 * 子树的重画。
 */
export function withEntry<T>(
  map: ReadonlyMap<string, T>,
  key: string,
  value: T,
): ReadonlyMap<string, T> {
  if (map.get(key) === value) {
    return map
  }

  const next = new Map(map)

  next.set(key, value)

  return next
}

export function withoutEntry<T>(map: ReadonlyMap<string, T>, key: string): ReadonlyMap<string, T> {
  if (!map.has(key)) {
    return map
  }

  const next = new Map(map)

  next.delete(key)

  return next
}
