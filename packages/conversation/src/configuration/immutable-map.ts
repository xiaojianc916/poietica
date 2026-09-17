/** 改动返回新表；未变保留引用，让上层 Object.is 跳过重画。 */
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
