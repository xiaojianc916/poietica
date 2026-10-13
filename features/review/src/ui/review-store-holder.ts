import { useEffect } from 'react'
import { createDeriver, type ReviewDeriver } from './derive'
import {
  createReviewStore,
  type ReviewDerive,
  type ReviewFailureReport,
  type ReviewGateway,
  type ReviewStore,
} from './review-store'

/* 每个工作区**只有一份**审查 store（按引用计数共享）。「Git 工具」那一格与右侧「审查」面板画的是同一份事实，两边各建一份 store
 * 就是两次读、两条刷新路径 —— 屏幕上会出现「面板说 +3 -1、浮层说 +0 -0」。同一份 store 也把 git.watch 的引用计数用满。
 * 生命周期：渲染期 obtain 只查表，effect 里 retain 才真的 start，最后一个消费者走掉才 stop。条目本身**不删**：StrictMode 会把
 * effect 跑两遍（挂载 → 卸载 → 再挂载），删掉再建会让组件手里那个 store 变成孤儿，屏幕上就是一块再也不刷新的旧数据。 */

interface Held {
  readonly store: ReviewStore
  refs: number
  stop: (() => void) | null
  readonly deriver: { held: ReviewDeriver | null }
}

const held = new Map<string, Held>()

function obtain(gateway: ReviewGateway, report: ReviewFailureReport): Held {
  const key = gateway.workspaceId
  const existing = held.get(key)
  if (existing !== undefined) {
    return existing
  }
  const deriver: { held: ReviewDeriver | null } = { held: null }
  const derive: ReviewDerive = (patch, wordDiff) => {
    deriver.held ??= createDeriver()
    return deriver.held.derive(patch, wordDiff)
  }
  const entry: Held = { deriver, refs: 0, stop: null, store: createReviewStore({ derive, gateway, report }) }
  held.set(key, entry)
  return entry
}

/** 交回的函数必须成对调用（effect 的清理）。 */
function retain(entry: Held): () => void {
  entry.refs += 1
  entry.stop ??= entry.store.start()
  let released = false
  return () => {
    if (released) {
      return
    }
    released = true
    entry.refs -= 1
    if (entry.refs > 0) {
      return
    }
    entry.stop?.()
    entry.stop = null
    entry.deriver.held?.dispose()
    entry.deriver.held = null
  }
}

export function useReviewStore(gateway: ReviewGateway, report: ReviewFailureReport): ReviewStore {
  const entry = obtain(gateway, report)
  useEffect(() => retain(entry), [entry])
  return entry.store
}
