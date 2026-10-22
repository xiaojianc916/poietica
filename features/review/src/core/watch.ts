import { toDisposable } from '@poietica/foundation'
import { watchRepository } from '@poietica/git'

/**
 * 按工作区计数 + 300ms 去抖（去抖在 watchRepository 里）：多个部件可能同时 watch 同一个工作区（审查面板、状态面板那一格），
 * 计数归零才停止监听。
 *
 * 键是 workspaceId 而不是路径，通知只有一个出口（onChange(workspaceId)）：
 * - unwatch 不必再问工作区的路径 —— 工作区被移走后那一问会抛错，旧实现把错吞掉，那一份监听于是永远不停；
 * - 每次 watch 不再往集合里塞一个新的回调 —— 旧实现 unwatch 只减计数不摘回调，来回几次之后一次改动会发好几条 git.changed。
 */
export interface ReviewWatcher {
  watch(workspaceId: string, path: string): void
  unwatch(workspaceId: string): void
  /** 工作区被移除：不论计数多少，停掉。 */
  forget(workspaceId: string): void
  dispose(): void
}

export function createReviewWatcher(d: {
  readonly start: (path: string, onChange: () => void) => { dispose(): void }
  readonly onChange: (workspaceId: string) => void
}): ReviewWatcher {
  interface Entry {
    count: number
    readonly path: string
    readonly handle: { dispose(): void }
  }
  const entries = new Map<string, Entry>()

  const stop = (workspaceId: string): void => {
    const held = entries.get(workspaceId)
    if (held === undefined) return
    entries.delete(workspaceId)
    held.handle.dispose()
  }

  return {
    watch(workspaceId, path) {
      const held = entries.get(workspaceId)
      if (held !== undefined && held.path === path) {
        held.count += 1
        return
      }
      /* 同一个工作区换了目录（重新指向）：旧目录不能再看下去，计数沿用。 */
      const count = (held?.count ?? 0) + 1
      stop(workspaceId)
      entries.set(workspaceId, { count, path, handle: d.start(path, () => d.onChange(workspaceId)) })
    },
    unwatch(workspaceId) {
      const held = entries.get(workspaceId)
      if (held === undefined) return
      held.count -= 1
      if (held.count <= 0) stop(workspaceId)
    },
    forget: stop,
    dispose() {
      for (const workspaceId of [...entries.keys()]) stop(workspaceId)
    },
  }
}

export function repositoryWatcher(onError: (error: Error) => void) {
  return (path: string, onChange: () => void) => toDisposable(watchRepository(path, onChange, { onError }).dispose)
}
