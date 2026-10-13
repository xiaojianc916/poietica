import { useFeatureStore } from '@poietica/ui-kernel'
import { useMemo } from 'react'
import type { TurnStatesStore } from '../session'

/*
 * 运行中的线程标记（侧栏那一圈转动的标记）。这是**组件里**读它的唯一入口。
 *
 * 两条判据缺一不可：
 *   1. 必须订阅着读 —— turnStates 由 turns.state 通知逐条写入，读快照的话那圈标记
 *      只停在首帧那一次（多半一条都还没有）；
 *   2. 选择器必须交回**稳定引用**：这里选的是 byThread 这个对象本身（Object.is 比得动），
 *      集合在外层派生。把 `new Set(...)` 写进选择器，useShallow 比的是集合引用，
 *      永远判成「变了」，组件会一路重渲染到 "Maximum update depth exceeded"
 *      （真实故障；内核在 useFeatureStoreShallow 的头注里警告过同一件事）。
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
