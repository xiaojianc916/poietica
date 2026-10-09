import type { QueueSnapshot } from '@poietica/engine'
import { createFeatureStore, type FeatureStore } from '@poietica/ui-kernel'
import type { ConversationApi } from '../api'

export const EMPTY_QUEUE: QueueSnapshot = { items: [], modes: { steer: 'all', followUp: 'all' } }

export interface QueueState {
  readonly byThread: Readonly<Record<string, QueueSnapshot>>
}

export interface QueueStore {
  readonly store: FeatureStore<QueueState>
  get(threadId: string): QueueSnapshot
  set(threadId: string, queue: QueueSnapshot): void
  refresh(threadId: string): Promise<void>
  withdraw(threadId: string, itemId: string): Promise<void>
}

export function createQueueStore(api: ConversationApi): QueueStore {
  const store = createFeatureStore<QueueState>(() => ({ byThread: {} }))
  return {
    store,
    get: (threadId) => store.getState().byThread[threadId] ?? EMPTY_QUEUE,
    set: (threadId, queue) => {
      store.setState((s) => ({ byThread: { ...s.byThread, [threadId]: queue } }))
    },
    async refresh(threadId) {
      const queue = await api.getQueue(threadId)
      store.setState((s) => ({ byThread: { ...s.byThread, [threadId]: queue } }))
    },
    async withdraw(threadId, itemId) {
      const queue = await api.withdraw(threadId, itemId)
      store.setState((s) => ({ byThread: { ...s.byThread, [threadId]: queue } }))
    },
  }
}
