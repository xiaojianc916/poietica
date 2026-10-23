import { useFeatureStore } from '@poietica/ui-kernel'
import { useMemo } from 'react'
import type { CompletionUnreadStore, TurnStatesStore } from '../threads'

/*
 * 两条判据缺一不可：必须订阅着读（turnStates 由通知逐条写入，读快照的话那圈标记只停在首帧那一次）；
 * 选择器必须交回**稳定引用**（这里选 byThread 这个对象本身，集合在外层派生）。把 `new Set(...)` 写进选择器会一路重渲染到 "Maximum update depth exceeded"（真实故障）。
 *
 * 「在跑」= 状态不是 idle。awaiting 也算在跑：那一轮并没有结束，只是停在等人答复上 ——
 * 侧栏的行首状态点据此仍显示活动（待答交互自己那一档由 pendingInteraction 抢先画）。
 */
export function useRunningThreadIds(store: TurnStatesStore): ReadonlySet<string> {
  const byThread = useFeatureStore(store.store, (s) => s.byThread)
  return useMemo(
    () =>
      new Set(
        Object.values(byThread)
          .filter((s) => s.state !== 'idle')
          .map((s) => s.threadId),
      ),
    [byThread],
  )
}

/**
 * 跑完但还没回来点开的那几条（DSH 的绿点）。
 *
 * 与 useRunningThreadIds 同一条引用纪律：集合在 useMemo 里派生，选择器交回 Set 本身。
 * 存的是 ReadonlySet，每次变更都已经换过引用，这里直接选它。
 */
export function useCompletionUnreadIds(store: CompletionUnreadStore): ReadonlySet<string> {
  return useFeatureStore(store.store, (s) => s.ids)
}
