import { toDisposable } from '@poietica/foundation'
import { watchRepository } from '@poietica/git'

/**
 * 引用计数 + 300ms 去抖（07 页 §10C）：多个面板或标题栏部件可能同时 watch 同一个
 * 工作区，计数归零才停止监听；去抖与忽略噪音在 `watchRepository` 里。
 */
export interface ReviewWatcher {
  watch(path: string, onChange: () => void): void
  unwatch(path: string): void
  dispose(): void
}

export function createReviewWatcher(d: {
  readonly start: (path: string, onChange: () => void) => { dispose(): void }
  readonly onError?: (error: Error) => void
}): ReviewWatcher {
  interface Entry {
    count: number
    disposable: { dispose(): void }
    listeners: Set<() => void>
  }
  const entries = new Map<string, Entry>()

  return {
    watch(path, onChange) {
      const held = entries.get(path)
      if (held !== undefined) {
        held.count += 1
        held.listeners.add(onChange)
        return
      }
      const listeners = new Set([onChange])
      const entry: Entry = {
        count: 1,
        listeners,
        disposable: { dispose: () => undefined },
      }
      entry.disposable = d.start(path, () => {
        for (const listener of listeners) listener()
      })
      entries.set(path, entry)
    },
    unwatch(path) {
      const held = entries.get(path)
      if (held === undefined) return
      held.count -= 1
      if (held.count > 0) return
      entries.delete(path)
      held.disposable.dispose()
    },
    dispose() {
      for (const entry of entries.values()) entry.disposable.dispose()
      entries.clear()
    },
  }
}

export function repositoryWatcher(onError: (error: Error) => void) {
  return (path: string, onChange: () => void) => toDisposable(watchRepository(path, onChange, { onError }).dispose)
}
