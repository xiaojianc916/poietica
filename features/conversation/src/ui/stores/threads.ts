import { createFeatureStore, type FeatureStore } from '@poietica/ui-kernel'
import type { Thread } from '../../contract'
import type { ConversationApi } from '../api'

export interface ThreadsState {
  readonly items: readonly Thread[]
  readonly workspaceId: string | null
  readonly includeArchived: boolean
  readonly isLoading: boolean
  readonly failure: string | null
}

export interface ThreadsStore {
  readonly store: FeatureStore<ThreadsState>
  refresh(): Promise<void>
  setWorkspace(workspaceId: string | null): void
  setIncludeArchived(v: boolean): void
  /** 通知与本地写入都走它：同一个 id 就替换，新的就按 pinned/updatedAt 排进去 */
  upsert(thread: Thread): void
  remove(threadId: string): void
  byId(threadId: string): Thread | undefined
}

/** pinned DESC, updated_at DESC —— 与服务端的排序一致（07 页 §5C）；本地插入也照它排 */
export function orderThreads(items: readonly Thread[]): readonly Thread[] {
  return [...items].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
    return b.updatedAt - a.updatedAt
  })
}

export function createThreadsStore(api: ConversationApi): ThreadsStore {
  const store = createFeatureStore<ThreadsState>(() => ({
    items: [],
    workspaceId: null,
    includeArchived: false,
    isLoading: true,
    failure: null,
  }))

  const merge = (thread: Thread): void => {
    store.setState((s) => ({ items: orderThreads([...s.items.filter((t) => t.id !== thread.id), thread]) }))
  }

  return {
    store,
    byId: (threadId) => store.getState().items.find((t) => t.id === threadId),
    upsert: merge,
    remove: (threadId) => {
      store.setState((s) => ({ items: s.items.filter((t) => t.id !== threadId) }))
    },
    setWorkspace: (workspaceId) => {
      store.setState({ workspaceId })
    },
    setIncludeArchived: (includeArchived) => {
      store.setState({ includeArchived })
    },
    async refresh() {
      const { workspaceId, includeArchived } = store.getState()
      store.setState({ isLoading: true })
      try {
        const items = await api.listThreads({
          ...(workspaceId === null ? {} : { workspaceId }),
          includeArchived,
        })
        store.setState({ items: orderThreads(items), isLoading: false, failure: null })
      } catch (e) {
        store.setState({ isLoading: false, failure: e instanceof Error ? e.message : String(e) })
      }
    },
  }
}
