import type { AppSettings, Problem, SettingsWriteResult } from '@poietica/contract/settings'
export interface SettingsPersistence {
  readonly read: () => Promise<AppSettings>
  readonly save: (settings: AppSettings) => Promise<SettingsWriteResult>
  readonly reset: () => Promise<SettingsWriteResult>
}
export interface SettingsStore {
  readonly getSnapshot: () => AppSettings | undefined
  readonly subscribe: (listener: () => void) => () => void
  readonly load: (options?: { readonly refresh?: boolean }) => Promise<AppSettings>
  readonly save: (settings: AppSettings) => Promise<void>
  readonly reset: () => Promise<AppSettings>
}
export interface ManagedSettingsStore extends SettingsStore {
  readonly dispose: () => Promise<void>
}
export function createSettingsStore(options: {
  readonly persistence: SettingsPersistence
  readonly onApplicationProblem: (problem: Problem) => void
}): ManagedSettingsStore {
  let current: AppSettings | undefined
  let pending: Promise<AppSettings> | undefined
  let writes = Promise.resolve()
  let closing: Promise<void> | undefined
  let revision = 0
  let readVersion = 0
  let closed = false
  const listeners = new Set<() => void>()
  const accepted = new Set<Promise<unknown>>()
  const stopped = () => new DOMException('Settings store is disposed.', 'AbortError')
  const requireActive = (): void => {
    if (closed) {
      throw stopped()
    }
  }
  const observe = (work: () => void): void => {
    try {
      work()
    } catch (cause) {
      queueMicrotask(() => {
        throw new Error('Settings observer failed.', { cause })
      })
    }
  }
  const publish = (settings: AppSettings): AppSettings => {
    current = structuredClone(settings)
    if (!closed) {
      for (const listener of listeners) {
        observe(listener)
      }
    }
    return current
  }
  const commit = (receipt: SettingsWriteResult): AppSettings => {
    revision += 1
    const snapshot = publish(receipt.settings)
    const problem = receipt.applicationProblem
    if (!closed && problem !== null) {
      observe(() => options.onApplicationProblem(problem))
    }
    return snapshot
  }
  const enqueue = <T>(work: () => Promise<T>): Promise<T> => {
    if (closed) {
      return Promise.reject(stopped())
    }
    revision += 1
    const result = writes.then(work)
    accepted.add(result)
    const release = (): void => {
      accepted.delete(result)
    }
    void result.then(release, release)
    // Only the queue tail absorbs failure; callers retain the original rejection.
    writes = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }
  return {
    getSnapshot: () => current,
    subscribe(listener) {
      requireActive()
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    load(request = {}) {
      if (closed) {
        return Promise.reject(stopped())
      }
      if (!request.refresh && current !== undefined) {
        return Promise.resolve(current)
      }
      if (!request.refresh && pending !== undefined) {
        return pending
      }
      const version = ++readVersion
      const loading = writes.then(async () => {
        requireActive()
        const observedRevision = revision
        const settings = await options.persistence.read()
        requireActive()
        if (version !== readVersion || observedRevision !== revision) {
          if (current !== undefined) {
            return current
          }
          throw new DOMException('Settings read was superseded.', 'AbortError')
        }
        return publish(settings)
      })
      pending = loading
      const release = (): void => {
        if (pending === loading) {
          pending = undefined
        }
      }
      void loading.then(release, release)
      return loading
    },
    save(settings) {
      const submitted = structuredClone(settings)
      return enqueue(async () => {
        commit(await options.persistence.save(submitted))
      })
    },
    reset: () => enqueue(async () => commit(await options.persistence.reset())),
    dispose() {
      if (closing !== undefined) {
        return closing
      }
      closed = true
      readVersion += 1
      listeners.clear()
      closing = Promise.allSettled([...accepted]).then((results) => {
        const failures: unknown[] = []
        for (const result of results) {
          if (result.status === 'rejected') {
            failures.push(result.reason)
          }
        }
        if (failures.length) {
          throw new AggregateError(failures, 'Settings writes did not drain successfully.')
        }
      })
      return closing
    },
  }
}
