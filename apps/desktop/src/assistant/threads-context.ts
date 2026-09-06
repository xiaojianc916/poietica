import {
  groupByWorkspace,
  type ThreadsStore,
  type ThreadWorkspaceList,
} from '@poietica/conversation'
import { createContext, useCallback, useContext, useMemo, useSyncExternalStore } from 'react'
import type { ConversationEntry } from './conversation-entry'
import type { WorkspaceCollapse } from './workspace-collapse'

export const ThreadsContext = createContext<ThreadsStore | null>(null)

function useStore(): ThreadsStore {
  const shared = useContext(ThreadsContext)

  if (shared === null) {
    throw new Error('会话状态需要上层的 ThreadsProvider')
  }

  return shared
}

/** 只要动作，不订阅：拿到的回调引用终生不变，可以直接传给行组件。 */
export function useThreadsActions(): ThreadsStore {
  return useStore()
}

export function useThreadsList(): ThreadWorkspaceList {
  const store = useStore()

  const list = useSyncExternalStore(store.subscribe, store.listSnapshot, store.listSnapshot)

  const groups = useMemo(() => groupByWorkspace(list.items), [list.items])

  return { failure: list.failure, groups, isLoading: list.isLoading }
}

export function useConversationWorkspaceRoot(conversationId: string | null): string | null {
  const store = useStore()

  const read = useCallback(
    () => (conversationId === null ? null : store.rootOf(conversationId)),
    [conversationId, store],
  )

  return useSyncExternalStore(store.subscribe, read, read)
}

export const ConversationEntryContext = createContext<ConversationEntry | null>(null)
export const WorkspaceCollapseContext = createContext<WorkspaceCollapse | null>(null)
export function useConversationEntry(): ConversationEntry {
  const entry = useContext(ConversationEntryContext)
  if (entry === null) {
    throw new Error('Conversation entry must be supplied by the application.')
  }
  return entry
}
export function useCollapsedWorkspaces() {
  const store = useContext(WorkspaceCollapseContext)
  if (store === null) {
    throw new Error('Workspace collapse preferences must be supplied by the application.')
  }
  const collapsed = useSyncExternalStore(store.subscribe, store.read, store.readFallback)
  return [collapsed, store.toggle] as const
}
