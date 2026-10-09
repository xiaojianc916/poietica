import { watch } from 'node:fs'
import { type Clock, type Disposable, systemClock, toDisposable } from '@poietica/foundation'

/**
 * 某个相对路径（相对仓库根目录）的变化是否值得刷新 git 状态。
 * .git 目录内只关心 HEAD、index、packed-refs、MERGE_HEAD 与 refs/**（对象库、日志、锁文件的变化太频繁且无意义）；
 * 任意层级的 node_modules 忽略。
 */
export function isNoteworthy(relativePath: string): boolean {
  const p = relativePath.replace(/\\/g, '/')
  if (p === 'node_modules' || p.startsWith('node_modules/') || p.includes('/node_modules/')) return false
  if (p === '.git') return false
  if (p.startsWith('.git/')) {
    const inner = p.slice(5)
    return (
      inner === 'HEAD' ||
      inner === 'index' ||
      inner === 'packed-refs' ||
      inner === 'MERGE_HEAD' ||
      inner.startsWith('refs/')
    )
  }
  return true
}

/**
 * 递归监听仓库目录（Windows 原生支持 recursive），值得关注的变化在 debounceMs 静默后合并通知一次。
 * 目录被删除等错误交给 onError，之后监听停止（调用方可选择重新 watch）。
 */
export function watchRepository(
  root: string,
  onChange: () => void,
  o: { readonly debounceMs?: number; readonly clock?: Clock; readonly onError?: (error: Error) => void } = {},
): Disposable {
  const clock = o.clock ?? systemClock
  const debounceMs = o.debounceMs ?? 300
  let timer: Disposable | undefined
  let disposed = false
  const watcher = watch(root, { recursive: true }, (_event, filename) => {
    if (disposed) return
    if (filename !== null && !isNoteworthy(filename.toString())) return
    timer?.dispose()
    timer = clock.setTimeout(() => {
      timer = undefined
      if (!disposed) onChange()
    }, debounceMs)
  })
  watcher.on('error', (error) => {
    if (!disposed) o.onError?.(error)
  })
  return toDisposable(() => {
    disposed = true
    timer?.dispose()
    watcher.close()
  })
}
