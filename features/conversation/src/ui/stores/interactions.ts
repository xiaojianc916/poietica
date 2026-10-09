import type { Interaction } from '@poietica/engine'
import { createFeatureStore, type FeatureStore } from '@poietica/ui-kernel'
import type { ConversationApi } from '../api'

export interface InteractionsState {
  readonly byThread: Readonly<Record<string, readonly Interaction[]>>
}

export interface InteractionsStore {
  readonly store: FeatureStore<InteractionsState>
  get(threadId: string): readonly Interaction[]
  upsert(threadId: string, interaction: Interaction): void
  resolve(threadId: string, interactionId: string): void
  refresh(threadId: string): Promise<void>
  clear(threadId: string): void
}

const NONE: readonly Interaction[] = []

export function createInteractionsStore(api: ConversationApi): InteractionsStore {
  const store = createFeatureStore<InteractionsState>(() => ({ byThread: {} }))
  const put = (threadId: string, next: readonly Interaction[]): void => {
    store.setState((s) => ({ byThread: { ...s.byThread, [threadId]: next } }))
  }
  return {
    store,
    get: (threadId) => store.getState().byThread[threadId] ?? NONE,
    upsert: (threadId, interaction) => {
      const current = store.getState().byThread[threadId] ?? NONE
      put(threadId, [...current.filter((i) => i.id !== interaction.id), interaction])
    },
    resolve: (threadId, interactionId) => {
      const current = store.getState().byThread[threadId] ?? NONE
      put(
        threadId,
        current.filter((i) => i.id !== interactionId),
      )
    },
    async refresh(threadId) {
      put(threadId, await api.listInteractions(threadId))
    },
    clear: (threadId) => {
      store.setState((s) => {
        const next = { ...s.byThread }
        delete next[threadId]
        return { byThread: next }
      })
    },
  }
}
