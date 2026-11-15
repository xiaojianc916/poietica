import type { ModuleDatabase, SqlValue } from '@poietica/storage-sqlite'
import type { Workspace } from '../contract'

export interface WorkspaceRow {
  id: string
  path: string
  pathKey: string
  name: string
  createdAt: number
  lastOpenedAt: number
  mode: 'local' | 'isolated'
  sourcePath: string | null
  baseRef: string | null
  branch: string | null
}

interface Row {
  id: string
  path: string
  path_key: string
  name: string
  created_at: number
  last_opened_at: number
  mode: string
  source_path: string | null
  base_ref: string | null
  branch: string | null
}

export interface WorkspacesRepository {
  insert(row: WorkspaceRow): void
  get(id: string): WorkspaceRow | null
  findByKey(pathKey: string): WorkspaceRow | null
  list(): WorkspaceRow[]
  update(id: string, patch: Partial<Omit<WorkspaceRow, 'id'>>): void
  delete(id: string): void
}

const COLUMNS = 'id, path, path_key, name, created_at, last_opened_at, mode, source_path, base_ref, branch'

const UPDATABLE = [
  ['path', 'path'],
  ['pathKey', 'path_key'],
  ['name', 'name'],
  ['createdAt', 'created_at'],
  ['lastOpenedAt', 'last_opened_at'],
  ['mode', 'mode'],
  ['sourcePath', 'source_path'],
  ['baseRef', 'base_ref'],
  ['branch', 'branch'],
] as const satisfies readonly (readonly [keyof Omit<WorkspaceRow, 'id'>, string])[]

function toRow(r: Row): WorkspaceRow {
  return {
    id: r.id,
    path: r.path,
    pathKey: r.path_key,
    name: r.name,
    createdAt: r.created_at,
    lastOpenedAt: r.last_opened_at,
    mode: r.mode === 'isolated' ? 'isolated' : 'local',
    sourcePath: r.source_path,
    baseRef: r.base_ref,
    branch: r.branch,
  }
}

/** exists 由调用方实时检查：目录失效不自动删除。 */
export function workspaceOf(row: WorkspaceRow, exists: boolean): Workspace {
  return {
    id: row.id,
    path: row.path,
    name: row.name,
    createdAt: row.createdAt,
    lastOpenedAt: row.lastOpenedAt,
    exists,
    mode: row.mode,
    sourcePath: row.sourcePath,
    baseRef: row.baseRef,
    branch: row.branch,
  }
}

export function createWorkspacesRepository(db: ModuleDatabase): WorkspacesRepository {
  return {
    insert(row) {
      db.prepare(`INSERT INTO workspaces_workspaces (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        row.id,
        row.path,
        row.pathKey,
        row.name,
        row.createdAt,
        row.lastOpenedAt,
        row.mode,
        row.sourcePath,
        row.baseRef,
        row.branch,
      )
    },
    get(id) {
      const r = db.prepare<Row>(`SELECT ${COLUMNS} FROM workspaces_workspaces WHERE id = ?`).get(id)
      return r === null || r === undefined ? null : toRow(r)
    },
    findByKey(key) {
      const r = db.prepare<Row>(`SELECT ${COLUMNS} FROM workspaces_workspaces WHERE path_key = ?`).get(key)
      return r === null || r === undefined ? null : toRow(r)
    },
    list() {
      return db
        .prepare<Row>(`SELECT ${COLUMNS} FROM workspaces_workspaces ORDER BY last_opened_at DESC`)
        .all()
        .map(toRow)
    },
    update(id, patch) {
      const sets: string[] = []
      const params: SqlValue[] = []
      for (const [key, column] of UPDATABLE) {
        const value = patch[key]
        if (value === undefined) continue
        sets.push(`${column} = ?`)
        params.push(value)
      }
      if (sets.length === 0) return
      params.push(id)
      db.prepare(`UPDATE workspaces_workspaces SET ${sets.join(', ')} WHERE id = ?`).run(...params)
    },
    delete(id) {
      db.prepare('DELETE FROM workspaces_workspaces WHERE id = ?').run(id)
    },
  }
}
