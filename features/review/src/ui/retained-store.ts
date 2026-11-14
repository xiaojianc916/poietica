import { useEffect } from 'react'

/*
 * 按工作区常驻的 store（PR 列表与代码审查页各一份）共用这一条生命周期：
 * 渲染期只查表，effect 里 retain 才 start；最后一个消费者走掉才 stop。
 *
 * 条目本身不删：StrictMode 会把 effect 跑两遍（挂载 → 卸载 → 再挂载），
 * 删掉再建会让组件手里那个 store 变成孤儿，屏幕上就是一块再也不刷新的旧数据。
 */
export interface RetainedStore<TStore extends { start(): () => void }> {
  readonly store: TStore
  refs: number
  stop: (() => void) | null
  /** 最后一个消费者走掉时与 stop 一起释放的派生资源（例如 review 的 diff 器）。 */
  readonly release?: (() => void) | undefined
}

/** 交回的函数必须成对调用（effect 的清理）。 */
export function retain<TStore extends { start(): () => void }>(entry: RetainedStore<TStore>): () => void {
  entry.refs += 1
  entry.stop ??= entry.store.start()
  let released = false
  return () => {
    if (released) return
    released = true
    entry.refs -= 1
    if (entry.refs > 0) return
    entry.stop?.()
    entry.stop = null
    entry.release?.()
  }
}

export function useRetainedStore<TStore extends { start(): () => void }>(entry: RetainedStore<TStore>): void {
  useEffect(() => retain(entry), [entry])
}
