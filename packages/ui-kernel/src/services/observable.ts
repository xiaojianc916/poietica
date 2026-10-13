export interface Observable<T> {
  current(): T
  subscribe(listener: () => void): () => void
}

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
