import { createFeatureStore, type FeatureStore } from '@poietica/ui-kernel'
import type { TurnState } from '../../contract/entities'

/**
 * 「跑完了，但你还没回来看」的那一档（DSH 的 completionUnread 与绿点）。
 *
 * 它只活在渲染进程里，不落盘：位子的含义是「这个浏览器里你还没看过」，页面一刷新人就正
 * 看着列表，持久化只会留下一个不再成立的旧事实。Core 换代不清它 —— 传输断了不等于用户
 * 已经看过；重新开跑会清它，打开这条会话也会清它。
 *
 * 只在**边沿**上点亮：running / awaiting → idle，而且落点不是当前正看着的那条。首次快照
 * （previous 未知）里的 idle 不算一次完成，否则一开机满列绿点。
 */
export interface CompletionUnreadState {
  readonly ids: ReadonlySet<string>
}

export interface CompletionUnreadStore {
  readonly store: FeatureStore<CompletionUnreadState>
  /** 每次 turns.state 到达时喂一次；previous 是这一条通知之前那一格。 */
  readonly observe: (
    threadId: string,
    previous: TurnState['state'] | undefined,
    next: TurnState['state'],
    activeThreadId: string | null,
  ) => void
  /** 人打开了这条（或停在了这条上）：绿点消失，重复调用无副作用。 */
  consume(threadId: string | null): void
  /** 线程没了：位子跟着消失，别留一个再也点不开的提醒。 */
  clear(threadId: string): void
}

const EMPTY: ReadonlySet<string> = new Set()

function withChange(ids: ReadonlySet<string>, threadId: string, present: boolean): ReadonlySet<string> | null {
  const has = ids.has(threadId)
  if (has === present) return null
  const next = new Set(ids)
  if (present) next.add(threadId)
  else next.delete(threadId)
  return next
}

export function createCompletionUnreadStore(): CompletionUnreadStore {
  const store = createFeatureStore<CompletionUnreadState>(() => ({ ids: EMPTY }))

  const publish = (next: ReadonlySet<string> | null): void => {
    if (next !== null) store.setState({ ids: next })
  }

  return {
    store,
    observe: (threadId, previous, next, activeThreadId) => {
      const ids = store.getState().ids
      if (next !== 'idle') {
        /* 重新开跑（或停在等人答复上）：上一次的完成提醒已经过时。 */
        publish(withChange(ids, threadId, false))
        return
      }
      const settled = (previous === 'running' || previous === 'awaiting') && threadId !== activeThreadId
      publish(withChange(ids, threadId, settled))
    },
    consume: (threadId) => {
      if (threadId === null) return
      publish(withChange(store.getState().ids, threadId, false))
    },
    clear: (threadId) => {
      publish(withChange(store.getState().ids, threadId, false))
    },
  }
}
