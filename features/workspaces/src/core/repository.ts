import type { ModuleDatabase, SqlValue } from '@poietica/storage-sqlite'
import type { Workspace } from '../contract'

export interface WorkspaceRow {
  id: string
  kind: 'folder' | 'scratch'
  path: string
  pathKey: string
  name: string
  createdAt: number
  lastOpenedAt: number
}

interface Row {
  id: string
  kind: string
  path: string
  path_key: string
  name: string
  created_at: number
  last_opened_at: number
}

export interface WorkspacesRepository {
  insert(row: WorkspaceRow): void
  get(id: string): WorkspaceRow | null
  findByKey(pathKey: string): WorkspaceRow | null
  /** last_opened_at DESC */
  list(): WorkspaceRow[]
  update(id: string, patch: Partial<Omit<WorkspaceRow, 'id'>>): void
  delete(id: string): void
}

const COLUMNS = 'id, kind, path, path_key, name, created_at, last_opened_at'

function toRow(r: Row): WorkspaceRow {
  return {
    id: r.id,
    kind: r.kind as WorkspaceRow['kind'],
    path: r.path,
    pathKey: r.path_key,
    name: r.name,
    createdAt: r.created_at,
    lastOpenedAt: r.last_opened_at,
  }
}

/** 行 → 实体：exists 由调用方实时检查（07 页 §3C：目录失效不自动删除） */
export function workspaceOf(row: WorkspaceRow, exists: boolean): Workspace {
  return {
    id: row.id,
    kind: row.kind,
    path: row.path,
    name: row.name,
    createdAt: row.createdAt,
    lastOpenedAt: row.lastOpenedAt,
    exists,
  }
}

export function createWorkspacesRepository(db: ModuleDatabase): WorkspacesRepository {
  return {
    insert(row) {
      db.prepare(`INSERT INTO workspaces_workspaces (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
        row.id,
        row.kind,
        row.path,
        row.pathKey,
        row.name,
        row.createdAt,
        row.lastOpenedAt,
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
      const put = (col: string, value: SqlValue): void => {
        sets.push(`${col} = ?`)
        params.push(value)
      }
      if (patch.kind !== undefined) put('kind', patch.kind)
      if (patch.path !== undefined) put('path', patch.path)
      if (patch.pathKey !== undefined) put('path_key', patch.pathKey)
      if (patch.name !== undefined) put('name', patch.name)
      if (patch.createdAt !== undefined) put('created_at', patch.createdAt)
      if (patch.lastOpenedAt !== undefined) put('last_opened_at', patch.lastOpenedAt)
      if (sets.length === 0) return
      params.push(id)
      db.prepare(`UPDATE workspaces_workspaces SET ${sets.join(', ')} WHERE id = ?`).run(...params)
    },
    delete(id) {
      db.prepare('DELETE FROM workspaces_workspaces WHERE id = ?').run(id)
    },
  }
}
