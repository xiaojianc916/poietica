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
  /*
   * 审查 R-19-4：同一条对话的 refresh 可能一拍里来好几次（线程表面挂载、点侧栏 openThread、Core 就绪后的 resyncVisible、
   * StrictMode 双挂载）。进行中的请求按对话号共用一份，不重复打 controls.get。
   */
  const inflight = new Map<string, Promise<void>>()
  /*
   * 每条对话被 `set`（controls.changed 推来的整张表）写过几次。refresh 发出之后又来了一份推送，
   * 那份推送比 refresh 的应答新：应答回来时不能拿旧表把它盖掉。
   */
  const pushed = new Map<string, number>()
  const fetchControls = async (threadId: string): Promise<void> => {
    const generation = pushed.get(threadId) ?? 0
    try {
      const controls = await api.getControls(threadId)
      if ((pushed.get(threadId) ?? 0) !== generation) return
      store.setState((s) => ({
        byThread: { ...s.byThread, [threadId]: controls },
        failure: Object.fromEntries(Object.entries(s.failure).filter(([k]) => k !== threadId)),
      }))
    } catch (e) {
      if ((pushed.get(threadId) ?? 0) !== generation) return
      const message = e instanceof Error ? e.message : String(e)
      store.setState((s) => ({ failure: { ...s.failure, [threadId]: message } }))
    }
  }
  return {
    store,
    get: (threadId) => store.getState().byThread[threadId],
    failureOf: (threadId) => store.getState().failure[threadId],
    usageOf: (threadId) => store.getState().usage[threadId],
    setUsage: (threadId, usage) => {
      store.setState((s) => (s.usage[threadId] === usage ? s : { usage: { ...s.usage, [threadId]: usage } }))
    },
    set: (threadId, controls) => {
      pushed.set(threadId, (pushed.get(threadId) ?? 0) + 1)
      store.setState((s) => ({
        byThread: { ...s.byThread, [threadId]: controls },
        failure: Object.fromEntries(Object.entries(s.failure).filter(([k]) => k !== threadId)),
      }))
    },
    refresh(threadId) {
      const running = inflight.get(threadId)
      if (running !== undefined) return running
      const request = fetchControls(threadId).finally(() => {
        inflight.delete(threadId)
      })
      inflight.set(threadId, request)
      return request
    },
  }
}
