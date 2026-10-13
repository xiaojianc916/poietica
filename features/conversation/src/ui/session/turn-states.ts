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
  /** 当前写入版本（每次 set 自增）。`threads.list` 出发之前取一次，交回 hydrate。 */
  mark(): number
  /** 用列表快照打底：只覆盖「自 mark 以来没有收到过通知」的线程（R-04 §3.5）。 */
  hydrate(threads: readonly { readonly id: string; readonly state: TurnState['state'] }[], mark: number): void
  /** Core 丢失：全部回到 idle。不走 onTurnState 回调 —— 崩溃不是「一轮结束」，不弹通知。 */
  resetAll(): void
}

const IDLE = (threadId: string): TurnState => ({ threadId, state: 'idle', error: null, startedAt: null })

/** 同一格状态吗（三格逐项比过）。内容没变就不换引用，订阅者才不白重画。 */
function sameTurnState(left: TurnState, right: TurnState): boolean {
  return left.state === right.state && left.error === right.error && left.startedAt === right.startedAt
}

/** 列表快照里那条线程对应的状态格；快照没有开始时间，非 idle 沿用这一格已有的那个。 */
function snapshotEntry(threadId: string, state: TurnState['state'], prev: TurnState | undefined): TurnState {
  return {
    threadId,
    state,
    error: null,
    startedAt: state === 'idle' ? null : (prev?.startedAt ?? null),
  }
}

/**
 * 线程状态只来自 turns.state 通知与 threads.list 的 state 字段，UI 不推断（14 页 §9.5）。
 *
 * 快照与通知之间有竞态：`threads.list` 往返期间到达的通知比快照新（快照是出发时那一刻的），
 * 所以用版本号记账 —— 通知写过的那条线程，hydrate 不拿旧快照覆盖它（R-04 §3.5）。
 */
export function createTurnStatesStore(): TurnStatesStore {
  const store = createFeatureStore<TurnStatesState>(() => ({ byThread: {} }))
  /** 只在 mark/hydrate/set 之间用的非响应式账本；不进 store，订阅者不因它重画。 */
  let version = 0
  const touched = new Map<string, number>()

  const put = (state: TurnState): void => {
    store.setState((s) => {
      const prev = s.byThread[state.threadId]
      if (prev !== undefined && sameTurnState(prev, state)) {
        /* 交回原 state 对象：zustand 判等后不通知任何订阅者。 */
        return s
      }
      return { byThread: { ...s.byThread, [state.threadId]: state } }
    })
  }

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
      /* 通知到过就是更新的事实：即使内容没变也记版本，hydrate 才不会拿旧快照覆盖它。 */
      touched.set(state.threadId, ++version)
      put(state)
    },
    get: (threadId) => store.getState().byThread[threadId],
    isRunning: (threadId) => (store.getState().byThread[threadId] ?? IDLE(threadId)).state !== 'idle',
    runningCount: () => Object.values(store.getState().byThread).filter((s) => s.state !== 'idle').length,
    mark: () => version,
    hydrate: (threads, mark) => {
      const current = store.getState().byThread
      const next = { ...current }
      let changed = false
      for (const thread of threads) {
        if ((touched.get(thread.id) ?? 0) > mark) {
          /* 往返期间来过的通知比这份快照新，它说了算。 */
          continue
        }
        const prev = current[thread.id]
        const entry = snapshotEntry(thread.id, thread.state, prev)
        if (prev !== undefined && sameTurnState(prev, entry)) {
          continue
        }
        next[thread.id] = entry
        changed = true
      }
      if (changed) {
        store.setState({ byThread: next })
      }
    },
    resetAll: () => {
      touched.clear()
      store.setState({ byThread: {} })
    },
    clear: (threadId) => {
      touched.delete(threadId)
      store.setState((s) => {
        const next = { ...s.byThread }
        delete next[threadId]
        return { byThread: next }
      })
    },
  }
}
