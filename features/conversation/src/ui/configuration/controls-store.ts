import type { ContextUsage, Controls } from '@poietica/engine'
import { createFeatureStore, type FeatureStore } from '@poietica/ui-kernel'
import type { ConversationApi } from '../api'

export interface ControlsState {
  readonly byThread: Readonly<Record<string, Controls>>
  readonly failure: Readonly<Record<string, string>>
  /**
   * **与 byThread 分开一格**：它由 controls.contextChanged 单独写，而 byThread 整份来自 controls.get / controls.changed ——
   * 合成一格的话，每一条用量通知都会把整张控件表（含模型候选清单）一起换掉。缺席（从没收到过报数）与 null（报过但此刻没有窗口）是两件事。
   */
  readonly usage: Readonly<Record<string, ContextUsage | null>>
}

export interface ControlsStore {
  readonly store: FeatureStore<ControlsState>
  get(threadId: string): Controls | undefined
  failureOf(threadId: string): string | undefined
  /** 这条对话最近一次报的上下文用量；从没报过是 undefined（报过而此刻没有是 null）。 */
  usageOf(threadId: string): ContextUsage | null | undefined
  refresh(threadId: string): Promise<void>
  set(threadId: string, controls: Controls): void
  /** 一份用量到达（controls.contextChanged）。写的是 usage 那一格，不动控件表。 */
  setUsage(threadId: string, usage: ContextUsage | null): void
}

export function createControlsStore(api: ConversationApi): ControlsStore {
  const store = createFeatureStore<ControlsState>(() => ({ byThread: {}, failure: {}, usage: {} }))
  return {
    store,
    get: (threadId) => store.getState().byThread[threadId],
    failureOf: (threadId) => store.getState().failure[threadId],
    usageOf: (threadId) => store.getState().usage[threadId],
    setUsage: (threadId, usage) => {
      store.setState((s) => (s.usage[threadId] === usage ? s : { usage: { ...s.usage, [threadId]: usage } }))
    },
    set: (threadId, controls) => {
      store.setState((s) => ({
        byThread: { ...s.byThread, [threadId]: controls },
        failure: Object.fromEntries(Object.entries(s.failure).filter(([k]) => k !== threadId)),
      }))
    },
    async refresh(threadId) {
      try {
        const controls = await api.getControls(threadId)
        store.setState((s) => ({
          byThread: { ...s.byThread, [threadId]: controls },
          failure: Object.fromEntries(Object.entries(s.failure).filter(([k]) => k !== threadId)),
        }))
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e)
        store.setState((s) => ({ failure: { ...s.failure, [threadId]: message } }))
      }
    },
  }
}
