import path from 'node:path'
import { AppError, type Clock, createId, type Logger, SystemErrorCode } from '@poietica/foundation'
import { removeSafe } from '@poietica/fs-kit'
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
  readonly scratchDir: string
  readonly clock: Clock
  readonly logger: Logger
  /** → workspaces.changed 通知 */
  readonly emitChanged: () => void
  /** → ctx.events.emit(workspaceRemoved, e) */
  readonly emitRemoved: (e: WorkspaceRemoved) => void
  readonly fs: {
    isDirectory(p: string): boolean
    mkdir(p: string): Promise<void>
    exists(p: string): boolean
  }
}

export interface WorkspacesApi extends WorkspacesService {
  add(p: string): Workspace
  createScratch(): Promise<Workspace>
  rename(id: string, name: string): Workspace
  remove(id: string): Promise<void>
  touch(id: string): void
}

/** 盘符根目录的名字：path.basename('C:\\') 是空串，特殊处理为 'C:'（07 页 §3C 的坑 5） */
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
        // 已存在：更新 last_opened_at 并原样返回（07 页 §3C）
        d.repo.update(existing.id, { lastOpenedAt: now })
        return toEntity({ ...existing, lastOpenedAt: now })
      }
      const row: WorkspaceRow = {
        id: createId(),
        kind: 'folder',
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
    async createScratch() {
      const id = createId()
      const dir = path.join(d.scratchDir, id)
      await d.fs.mkdir(dir)
      const now = d.clock.now()
      const row: WorkspaceRow = {
        id,
        kind: 'scratch',
        path: dir,
        pathKey: pathKey(dir),
        name: '临时对话',
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
        /* 07 页 §3C：空名是**入参**不合法，不是「工作区不存在」 */
        throw new AppError(SystemErrorCode.invalidParams, '工作区名字不能为空')
      }
      d.repo.update(id, { name: trimmed })
      d.emitChanged()
      return toEntity({ ...row, name: trimmed })
    },
    async remove(id) {
      const row = requireRow(id)
      // 顺序（07 页 §3C）：先删行 → 再发 workspaceRemoved → 再删 scratch 目录 → 最后发 changed
      d.repo.delete(id)
      d.emitRemoved({ workspaceId: id, kind: row.kind, path: row.path })
      if (row.kind === 'scratch') {
        // removeSafe 拒绝删除 scratchDir 之外的路径：防止 bug 删错目录
        await removeSafe(row.path, { within: d.scratchDir }).catch((e: unknown) => {
          d.logger.warn('scratch remove failed', { workspaceId: id, error: String(e) })
        })
      }
      d.emitChanged()
    },
    touch(id) {
      // 不发通知：打开线程时会 touch，每次都发会让列表反复重排（07 页 §3C 的坑 4）
      requireRow(id)
      d.repo.update(id, { lastOpenedAt: d.clock.now() })
    },
  }
}
