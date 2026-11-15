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

export interface WorkspacesWorktreePort {
  create(input: {
    readonly repoPath: string
    readonly path: string
    readonly branch: string
    readonly base?: string
  }): Promise<unknown>
  remove(input: { readonly repoPath: string; readonly path: string; readonly branch?: string }): Promise<void>
  diff(input: { readonly path: string; readonly base: string }): Promise<string>
  apply(input: {
    readonly repoPath: string
    readonly patch: string
  }): Promise<{ readonly applied: true } | { readonly applied: false; readonly reason: string }>
}

export interface WorkspacesServiceDeps {
  readonly repo: WorkspacesRepository
  readonly clock: Clock
  readonly emitChanged: () => void
  /** 删除与 outbox 入队必须在同一事务里；UI 由随后的 emitChanged 刷新。 */
  readonly transaction: <T>(fn: () => T) => T
  readonly onRemoved: (e: WorkspaceRemoved) => void
  readonly fs: {
    isDirectory(p: string): boolean
  }
  /** 隔离工作区的实际创建/回收（§14.1）；不传时只能使用本地模式。 */
  readonly worktree?: WorkspacesWorktreePort
  readonly worktreesDir?: string
}

export interface WorkspacesApi extends WorkspacesService {
  add(p: string): Workspace
  rename(id: string, name: string): Workspace
  remove(id: string): Promise<void>
  touch(id: string): void
  /** 从本地工作区建一个隔离 worktree，作为独立工作区返回（线程可绑定它）。 */
  createIsolated(input: { readonly sourceWorkspaceId: string; readonly branch?: string }): Promise<Workspace>
  /** 把隔离工作区相对基线的补丁应用到主仓库；冲突不半写。 */
  deliver(id: string): Promise<{ readonly applied: true } | { readonly applied: false; readonly reason: string }>
  /** 删除隔离工作区与它的 worktree。 */
  discard(id: string): Promise<void>
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
        mode: 'local',
        sourcePath: null,
        baseRef: null,
        branch: null,
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
    async remove(id) {
      const row = requireRow(id)
      if (row.mode === 'isolated' && d.worktree !== undefined && row.sourcePath !== null) {
        await d.worktree.remove({
          repoPath: row.sourcePath,
          path: row.path,
          ...(row.branch === null ? {} : { branch: row.branch }),
        })
      }
      d.transaction(() => {
        d.repo.delete(id)
        d.onRemoved({ workspaceId: id, path: row.path })
      })
      d.emitChanged()
    },
    async createIsolated(input) {
      if (d.worktree === undefined || d.worktreesDir === undefined) {
        throw new AppError('workspaces.isolation_unavailable', '当前版本没有装配隔离工作区')
      }
      const source = requireRow(input.sourceWorkspaceId)
      if (source.mode === 'isolated') {
        throw new AppError('workspaces.not_local', '只能从本地工作区创建隔离副本')
      }
      if (!exists(source.path)) {
        throw new AppError(workspacesErrors.directory_missing, '工作区文件夹已不存在')
      }
      const id = createId()
      const branch = input.branch?.trim() || `poietica/isolated-${id.slice(0, 8)}`
      const worktreePath = path.join(d.worktreesDir, id)
      try {
        await d.worktree.create({ repoPath: source.path, path: worktreePath, branch, base: 'HEAD' })
      } catch (error) {
        throw new AppError('workspaces.worktree_failed', '创建隔离工作区失败', {
          cause: error instanceof Error ? error.message : String(error),
        })
      }
      const now = d.clock.now()
      const row: WorkspaceRow = {
        id,
        path: worktreePath,
        pathKey: pathKey(worktreePath),
        name: `${source.name}（隔离）`,
        createdAt: now,
        lastOpenedAt: now,
        mode: 'isolated',
        sourcePath: source.path,
        baseRef: 'HEAD',
        branch,
      }
      try {
        d.repo.insert(row)
      } catch (error) {
        await d.worktree.remove({ repoPath: source.path, path: worktreePath, branch }).catch(() => undefined)
        throw error
      }
      d.emitChanged()
      return toEntity(row)
    },
    async deliver(id) {
      const row = requireRow(id)
      if (row.mode !== 'isolated' || row.sourcePath === null) {
        throw new AppError('workspaces.not_isolated', '只有隔离工作区可以交付')
      }
      if (d.worktree === undefined) throw new AppError('workspaces.isolation_unavailable', '当前版本没有装配隔离工作区')
      const patch = await d.worktree.diff({ path: row.path, base: row.baseRef ?? 'HEAD' })
      if (patch.trim() === '') return { applied: true }
      return await d.worktree.apply({ repoPath: row.sourcePath, patch })
    },
    async discard(id) {
      const row = requireRow(id)
      if (row.mode !== 'isolated') {
        throw new AppError('workspaces.not_isolated', '只有隔离工作区可以丢弃')
      }
      if (d.worktree !== undefined && row.sourcePath !== null) {
        await d.worktree.remove({
          repoPath: row.sourcePath,
          path: row.path,
          ...(row.branch === null ? {} : { branch: row.branch }),
        })
      }
      d.transaction(() => {
        d.repo.delete(id)
        d.onRemoved({ workspaceId: id, path: row.path })
      })
      d.emitChanged()
    },
    touch(id) {
      // 不发通知：打开线程时会 touch，每次都发会让列表反复重排。
      requireRow(id)
      d.repo.update(id, { lastOpenedAt: d.clock.now() })
    },
  }
}
