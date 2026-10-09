import { type CoreEvent, defineCoreEvent } from '@poietica/core-kernel/events'
import { defineServiceToken } from '@poietica/foundation'
import type { Workspace } from '../contract'

export interface WorkspacesService {
  get(id: string): Workspace | null
  /** 不存在 → workspaces.not_found；目录已不存在 → workspaces.directory_missing */
  requireUsable(id: string): Workspace
  list(): readonly Workspace[]
}
export const WorkspacesServiceToken = defineServiceToken<WorkspacesService>('workspaces', 'WorkspacesService')

export interface WorkspaceRemoved {
  readonly workspaceId: string
  readonly kind: 'folder' | 'scratch'
  readonly path: string
}
export const workspaceRemoved: CoreEvent<WorkspaceRemoved> = defineCoreEvent<WorkspaceRemoved>(
  'workspaces',
  'workspaceRemoved',
)
