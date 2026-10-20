import path from 'node:path'
import { AppError, type Clock, createId, SystemErrorCode } from '@poietica/foundation'
import type { Workspace } from '../contract'
import { workspacesErrors } from '../contract/errors'
import type { WorkspaceRemoved } from '../core-api'
import { pathKey } from './path-key'
import { type WorkspaceRow, type WorkspacesRepository, workspaceOf } from './repository'

export interface WorkspacesService {
  get(id: string): Workspace | null
  requireUsable(id: string): Workspace
  list(): readonly Workspace[]
}

export interface WorkspacesServiceDeps {
  readonly repo: WorkspacesRepository
  readonly clock: Clock
  readonly emitChanged: () => void
  readonly emitRemoved: (e: WorkspaceRemoved) => void
  readonly fs: {
    isDirectory(p: string): boolean
  }
}

export interface WorkspacesApi extends WorkspacesService {
  add(p: string): Workspace
  rename(id: string, name: string): Workspace
  remove(id: string): void
  touch(id: string): void
}

/** path.basename('C:\\') 是空串，特殊处理为 'C:'。 */
export function nameOfPath(p: string): string {
  const resolved = path.resolve(p)
  const base = path.basename(resolved)
  if (base !== '') return base
  const parsed = path.parse(resolved)
  return parsed.root.replace(/[\\/]+$/, '') || parsed.root
}

export function createWorkspacesService(d: WorkspacesServiceDeps): WorkspacesApi {
  const exists = (p: string): boolean => {
    try {
      return d.fs.isDirectory(p)
    } catch {
      return false
    }
  }

  const toEntity = (row: WorkspaceRow): Workspace => workspaceOf(row, exists(row.path))

  const requireRow = (id: string): WorkspaceRow => {
    const row = d.repo.get(id)
    if (row === null) {
      throw new AppError(workspacesErrors.not_found, '工作区不存在')
    }
    return row
  }

  return {
    list() {
      return d.repo.list().map(toEntity)
    },
    get(id) {
      const row = d.repo.get(id)
      return row === null ? null : toEntity(row)
    },
    requireUsable(id) {
      const row = requireRow(id)
      if (!exists(row.path)) {
        throw new AppError(workspacesErrors.directory_missing, '工作区文件夹已不存在')
      }
      return toEntity(row)
    },
    add(p) {
      if (!exists(p)) {
        throw new AppError(workspacesErrors.not_a_directory, '所选路径不是文件夹')
      }
      const resolved = path.resolve(p)
      const key = pathKey(resolved)
      const existing = d.repo.findByKey(key)
      const now = d.clock.now()
      if (existing !== null) {
        d.repo.update(existing.id, { lastOpenedAt: now })
        return toEntity({ ...existing, lastOpenedAt: now })
      }
      const row: WorkspaceRow = {
        id: createId(),
        path: resolved,
        pathKey: key,
        name: nameOfPath(resolved),
        createdAt: now,
        lastOpenedAt: now,
      }
      d.repo.insert(row)
      d.emitChanged()
      return toEntity(row)
    },
    rename(id, name) {
      const row = requireRow(id)
      const trimmed = name.trim()
      if (trimmed === '') {
        /* 空名是**入参**不合法，不是「工作区不存在」。 */
        throw new AppError(SystemErrorCode.invalidParams, '工作区名字不能为空')
      }
      d.repo.update(id, { name: trimmed })
      d.emitChanged()
      return toEntity({ ...row, name: trimmed })
    },
    remove(id) {
      const row = requireRow(id)
      d.repo.delete(id)
      d.emitRemoved({ workspaceId: id, path: row.path })
      d.emitChanged()
    },
    touch(id) {
      // 不发通知：打开线程时会 touch，每次都发会让列表反复重排。
      requireRow(id)
      d.repo.update(id, { lastOpenedAt: d.clock.now() })
    },
  }
}
