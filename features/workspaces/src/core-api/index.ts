import { defineServiceToken } from '@poietica/foundation'
import { z } from 'zod'
import type { Workspace } from '../contract'

/** 工作区删除的持久副作用（ADR-011）：各清理方用同一个 topic 注册 outbox handler。 */
export const WORKSPACE_REMOVED_TOPIC = 'workspaces.removed'
export const workspaceRemovedPayload = z.object({ workspaceId: z.string().min(1), path: z.string().min(1) })

export interface WorkspacesService {
  get(id: string): Workspace | null
  /** 目录已不存在 → workspaces.directory_missing */
  requireUsable(id: string): Workspace
  list(): readonly Workspace[]
}
export const WorkspacesServiceToken = defineServiceToken<WorkspacesService>('workspaces', 'WorkspacesService')

export interface WorkspaceRemoved {
  readonly workspaceId: string
  readonly path: string
}

export * from './lease'
