import { createFeatureStore, type FeatureStore } from '@poietica/ui-kernel'
import type { TurnState } from '../../contract/entities'

export interface TurnStatesState {
  readonly byThread: Readonly<Record<string, TurnState>>
}

export interface TurnStatesStore {
  readonly store: FeatureStore<TurnStatesState>
  set(state: TurnState): void
  get(threadId: string): TurnState | undefined
  isRunning(threadId: string): boolean
  runningCount(): number
  clear(threadId: string): void
}

const IDLE = (threadId: string): TurnState => ({ threadId, state: 'idle', error: null, startedAt: null })

/** 线程状态只来自 turns.state 通知与 threads.list 的 state 字段，UI 不推断（14 页 §9.5） */
export function createTurnStatesStore(): TurnStatesStore {
  const store = createFeatureStore<TurnStatesState>(() => ({ byThread: {} }))
  return {
    store,
    /*
     * 写入一格，**内容没变就不换引用**。
     *
     * `turns.state` 通知会重复推同一个状态（例如一轮里连报两次 running），而无条件
     * `{ ...s.byThread, ... }` 每次都交回一个新对象 —— 订阅着读 byThread 的那些组件
     * （侧栏线程列表、输入框、时间线）会跟着重画一遍，白画。内容真变时才换引用，
     * 是「订阅式选择器能不能安定」的前提（见 __tests__/turn-states.test.ts）。
     */
    set: (state) => {
      store.setState((s) => {
        const prev = s.byThread[state.threadId]
        if (
          prev !== undefined &&
          prev.state === state.state &&
          prev.error === state.error &&
          prev.startedAt === state.startedAt
        ) {
          /* 交回原 state 对象：zustand 判等后不通知任何订阅者。 */
          return s
        }
        return { byThread: { ...s.byThread, [state.threadId]: state } }
      })
    },
    get: (threadId) => store.getState().byThread[threadId],
    isRunning: (threadId) => (store.getState().byThread[threadId] ?? IDLE(threadId)).state !== 'idle',
    runningCount: () => Object.values(store.getState().byThread).filter((s) => s.state !== 'idle').length,
    clear: (threadId) => {
      store.setState((s) => {
        const next = { ...s.byThread }
        delete next[threadId]
        return { byThread: next }
      })
    },
  }
}
