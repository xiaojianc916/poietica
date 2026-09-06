import { createContext, useContext, useSyncExternalStore } from 'react'
import type { WorkspaceLayoutState, WorkspaceLayoutStore } from './layout-store'

export const WorkspaceLayoutContext = createContext<WorkspaceLayoutStore | null>(null)
export function useWorkspaceLayoutStore(): WorkspaceLayoutStore {
  const store = useContext(WorkspaceLayoutContext)
  if (store === null) {
    throw new Error('Workspace layout must be supplied by the application.')
  }
  return store
}
export function useWorkspaceLayoutState(): WorkspaceLayoutState {
  const store = useWorkspaceLayoutStore()
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
}
