import type { UiFeatureContext } from '@poietica/ui-kernel'
import { useEffect } from 'react'
import { createGithubGateway, createReviewApi } from './api'
import { createPrStore, type PrFailureReport, type PrStore } from './pr-store'

/*
 * 代码审查页的 store 按工作区**常驻**：页面卸载（切到对话、设置……）时 store 不扔，再回来直接画上次读到的东西，
 * 新鲜期内不重读、过期了在背后重读（见 pr-store 的 FRESH_MS）。以前 store 跟着页面组件生灭，每次回来都是一张白纸、
 * 整页「加载中」再等一轮 GitHub。
 *
 * 生命周期照 review-store-holder：渲染期只查表，effect 里 retain 才 start（还在路上的回包靠 start 交回的清理作废），
 * 最后一个消费者走掉才 stop。条目**不删**：StrictMode 的「挂载 → 卸载 → 再挂载」不能把组件手里那个 store 变成孤儿，
 * 而留着条目本来就是缓存要的效果。工作区的数量是个位数，常驻的只是几十条 PR 的元数据。
 */

interface Held {
  readonly store: PrStore
  refs: number
  stop: (() => void) | null
  /* 报错走最新一次渲染给的那个回调（它闭包着 banners / logger），store 本身不必重建。 */
  report: PrFailureReport
}

const held = new Map<string, Held>()

function obtain(ctx: UiFeatureContext, workspaceId: string, report: PrFailureReport): Held {
  const existing = held.get(workspaceId)
  if (existing !== undefined) {
    existing.report = report
    return existing
  }
  const entry: Held = {
    refs: 0,
    stop: null,
    report,
    store: createPrStore({
      gateway: createGithubGateway(createReviewApi(ctx, workspaceId)),
      report: (context) => entry.report(context),
    }),
  }
  held.set(workspaceId, entry)
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
  }
}

export function usePrStore(ctx: UiFeatureContext, workspaceId: string, report: PrFailureReport): PrStore {
  const entry = obtain(ctx, workspaceId, report)
  useEffect(() => retain(entry), [entry])
  return entry.store
}
