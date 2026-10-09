export interface Observable<T> {
  current(): T
  subscribe(listener: () => void): () => void
}

/** 所有内核服务共用的最小可订阅值 */
export function createValue<T>(initial: T): Observable<T> & { set(next: T): void } {
  let value = initial
  const listeners = new Set<() => void>()
  return {
    current: () => value,
    subscribe: (l) => {
      listeners.add(l)
      return () => {
        listeners.delete(l)
      }
    },
    set: (next) => {
      if (Object.is(next, value)) return
      value = next
      for (const l of [...listeners]) l()
    },
  }
}
