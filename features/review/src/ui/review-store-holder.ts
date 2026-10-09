import { useEffect } from 'react'
import { createDeriver, type ReviewDeriver } from './derive'
import {
  createReviewStore,
  type ReviewDerive,
  type ReviewFailureReport,
  type ReviewGateway,
  type ReviewStore,
} from './review-store'

/*
 * 每个工作区**只有一份**审查 store（按引用计数共享）。
 *
 * 为什么需要它：状态面板的「Git 工具」那一格与右侧「审查」面板画的是同一份事实
 * （分支、改动清单、+N/-M）。两边各建一份 store 就是两次读、两条刷新路径 —— 屏幕上
 * 会出现「面板说 +3 -1、浮层说 +0 -0」这种自相矛盾（legacy 就是各建一份，产品负责人
 * 2026-10-07 点出这是老毛病）。这里让两处**共用同一个对象**，从根上不存在第二个真相。
 *
 * 同一份 store 还顺手把 git.watch 的引用计数用满：两个消费者只挂一次监听、只停一次。
 *
 * 生命周期：渲染期 obtain（只查表、必要时建表；不碰 IO、不起 worker），effect 里
 * retain 才真的 start，最后一个消费者走掉才 stop。条目本身**不删**（停在表里）：
 * React 的 StrictMode 会把 effect 跑两遍（挂载 → 卸载 → 再挂载），删掉再建会让组件
 * 手里那个 store 变成孤儿 —— 屏幕上就是一块再也不刷新的旧数据（真实故障的同一形状）。
 * derive 的 worker 惰性创建，所以「建了又没挂上」不会漏一个 Worker。
 */

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

/** 一个消费者进场：第一次进场才真的 start。交回的函数必须成对调用（effect 的清理）。 */
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

/**
 * 这一个工作区的审查 store。**同一个工作区永远是同一个对象**：
 * 「审查」面板与状态面板读它，所以两处的 +N/-M 与分支名必然一致。
 */
export function useReviewStore(gateway: ReviewGateway, report: ReviewFailureReport): ReviewStore {
  const entry = obtain(gateway, report)
  useEffect(() => retain(entry), [entry])
  return entry.store
}
