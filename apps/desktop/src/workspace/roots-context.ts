import { createContext, useContext, useSyncExternalStore } from 'react'
import type { WorkspaceRoots } from './roots'

export const WorkspaceRootsContext = createContext<WorkspaceRoots | null>(null)

export function useWorkspaceRoots(): WorkspaceRoots {
  const owner = useContext(WorkspaceRootsContext)
  if (owner === null) {
    throw new Error('WorkspaceRootsContext is not provided.')
  }
  return owner
}

export function useActiveWorkspaceRoot(): string | null {
  const owner = useWorkspaceRoots()
  return useSyncExternalStore(owner.subscribeActive, owner.readActive, owner.fallbackActive)
}
