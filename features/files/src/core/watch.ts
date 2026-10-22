import { watch } from 'node:fs'
import { type Disposable, toDisposable } from '@poietica/foundation'

/*
 * 工作区监听。
 *
 * 声明式而不是引用计数：界面每次交来「此刻要看的工作区全集」，这里把差额补齐、多余的停掉。审查那一路的 git.watch / git.unwatch
 * 是引用计数，Core 一重启计数就清零、界面却不知道要重发（见方案页问题 5）；全集重发天然幂等，onCoreReady 里再发一遍即可。
 */

/* 一个去抖窗口里攒的路径超过这么多就不逐条报了：交 null，界面整棵重读。 */
const PATHS_LIMIT = 256

export function isWatchedPath(relative: string): boolean {
  const p = relative.replaceAll('\\', '/')
  if (p === '.git' || p.startsWith('.git/')) return false
  return !(p === 'node_modules' || p.startsWith('node_modules/') || p.includes('/node_modules/'))
}

/** 递归监听一个根，去抖后交回这一窗口里变了的相对路径（正斜杠；太多或拿不到名字时为 null）。 */
export function watchTree(
  root: string,
  onChange: (paths: readonly string[] | null) => void,
  o: { readonly debounceMs?: number; readonly onError?: (error: Error) => void } = {},
): Disposable {
  const debounceMs = o.debounceMs ?? 300
  let timer: ReturnType<typeof setTimeout> | undefined
  let pending: Set<string> | null = new Set()
  let disposed = false
  const flush = (): void => {
    timer = undefined
    const paths = pending === null ? null : [...pending]
    pending = new Set()
    if (!disposed) onChange(paths)
  }
  const watcher = watch(root, { recursive: true }, (_event, filename) => {
    if (disposed) return
    const name = filename === null ? null : filename.toString().replaceAll('\\', '/')
    if (name !== null && !isWatchedPath(name)) return
    if (name === null || pending === null || pending.size >= PATHS_LIMIT) pending = null
    else pending.add(name)
    if (timer !== undefined) clearTimeout(timer)
    timer = setTimeout(flush, debounceMs)
  })
  watcher.on('error', (error) => {
    if (!disposed) o.onError?.(error)
  })
  return toDisposable(() => {
    disposed = true
    if (timer !== undefined) clearTimeout(timer)
    watcher.close()
  })
}

export interface WatchSet {
  /** 此刻要看的全集：workspaceId → 根目录。 */
  set(targets: ReadonlyMap<string, string>): void
  forget(workspaceId: string): void
  dispose(): void
}

export function createWatchSet(d: {
  readonly start: (root: string, onChange: (paths: readonly string[] | null) => void) => Disposable
  readonly onChange: (workspaceId: string, root: string, paths: readonly string[] | null) => void
}): WatchSet {
  const entries = new Map<string, { readonly root: string; readonly handle: Disposable }>()
  const stop = (workspaceId: string): void => {
    const held = entries.get(workspaceId)
    if (held === undefined) return
    entries.delete(workspaceId)
    held.handle.dispose()
  }
  return {
    set(targets) {
      for (const [workspaceId, held] of [...entries]) {
        if (targets.get(workspaceId) !== held.root) stop(workspaceId)
      }
      for (const [workspaceId, root] of targets) {
        if (entries.has(workspaceId)) continue
        const handle = d.start(root, (paths) => {
          d.onChange(workspaceId, root, paths)
        })
        entries.set(workspaceId, { root, handle })
      }
    },
    forget: stop,
    dispose() {
      for (const workspaceId of [...entries.keys()]) stop(workspaceId)
    },
  }
}
