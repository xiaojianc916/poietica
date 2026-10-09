import { createFeatureStore, type FeatureStore } from '@poietica/ui-kernel'
import { MAIN_AGENT_ID } from '../../contract/entities'
import type { ConversationApi } from '../api'
import { TimelineReplica } from './timeline-replica'

export interface TimelinesState {
  readonly revision: number
}

export interface TimelinesStore {
  readonly store: FeatureStore<TimelinesState>
  readonly replicas: ReadonlyMap<string, TimelineReplica>
  open(threadId: string): TimelineReplica
  close(threadId: string): void
  closeAll(): void
  resubscribeAll(): void
}

export function createTimelinesStore(api: ConversationApi): TimelinesStore {
  const replicas = new Map<string, TimelineReplica>()
  const store = createFeatureStore<TimelinesState>(() => ({ revision: 0 }))
  const bump = (): void => {
    store.setState((s) => ({ revision: s.revision + 1 }))
  }

  return {
    store,
    replicas,
    open(threadId) {
      const existing = replicas.get(threadId)
      if (existing !== undefined) return existing
      const replica = new TimelineReplica(api, threadId, MAIN_AGENT_ID, bump)
      replicas.set(threadId, replica)
      void replica.resubscribe()
      return replica
    },
    close(threadId) {
      const replica = replicas.get(threadId)
      if (replica === undefined) return
      replica.dispose()
      replicas.delete(threadId)
      bump()
    },
    closeAll() {
      for (const [id, replica] of [...replicas]) {
        replica.dispose()
        replicas.delete(id)
      }
      bump()
    },
    resubscribeAll() {
      for (const replica of replicas.values()) void replica.resubscribe()
    },
  }
}
