import { useFeatureStore } from '@poietica/ui-kernel'
import { useMemo } from 'react'
import type { TurnStatesStore } from '../threads'

/*
 * 两条判据缺一不可：必须订阅着读（turnStates 由通知逐条写入，读快照的话那圈标记只停在首帧那一次）；
 * 选择器必须交回**稳定引用**（这里选 byThread 这个对象本身，集合在外层派生）。把 `new Set(...)` 写进选择器会一路重渲染到 "Maximum update depth exceeded"（真实故障）。
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
