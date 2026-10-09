import type { ModelRef, Posture } from '@poietica/engine'
import type { ModuleDatabase, SqlValue } from '@poietica/storage-sqlite'
import type { Thread } from '../contract'

export interface ThreadRow {
  id: string
  workspaceId: string
  title: string
  titleSource: 'pending' | 'auto' | 'user'
  posture: Posture
  origin: 'user' | 'automation'
  /**
   * omp 会话 id 与文件路径。08 页 §5.2 的 CHECK 要求两者同时为空或同时有值，
   * 所以它们只在这一处一起写（不暴露给实体：Thread 只有 hasSession）。
   */
  sessionId: string | null
  sessionFile: string | null
  forkedFrom: string | null
  pinned: boolean
  archived: boolean
  initialModel: ModelRef | null
  initialThinking: string | null
  createdAt: number
  updatedAt: number
}

interface Row {
  id: string
  workspace_id: string
  title: string
  title_source: string
  posture: string
  origin: string
  session_id: string | null
  session_file: string | null
  initial_model_provider: string | null
  initial_model_id: string | null
  initial_thinking: string | null
  forked_from: string | null
  pinned: number
  archived: number
  created_at: number
  updated_at: number
}

export interface ThreadsRepository {
  insert(row: ThreadRow): void
  get(id: string): ThreadRow | null
  /** pinned DESC, updated_at DESC */
  list(q: { workspaceId?: string | undefined; includeArchived: boolean }): ThreadRow[]
  update(id: string, patch: Partial<Omit<ThreadRow, 'id'>>): void
  delete(id: string): void
  listByWorkspace(workspaceId: string): ThreadRow[]
}

const COLUMNS = `id, workspace_id, title, title_source, posture, origin, session_id, session_file,
  initial_model_provider, initial_model_id, initial_thinking, forked_from, pinned, archived,
  created_at, updated_at`

function toRow(r: Row): ThreadRow {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    title: r.title,
    titleSource: r.title_source as ThreadRow['titleSource'],
    posture: r.posture as Posture,
    origin: r.origin as ThreadRow['origin'],
    sessionId: r.session_id,
    sessionFile: r.session_file,
    forkedFrom: r.forked_from,
    pinned: r.pinned === 1,
    archived: r.archived === 1,
    initialModel:
      r.initial_model_provider !== null && r.initial_model_id !== null
        ? { provider: r.initial_model_provider, id: r.initial_model_id }
        : null,
    initialThinking: r.initial_thinking,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

/** 行 → 实体。state 由会话池决定（不在池中即 idle），这里只负责其余字段 */
export function threadOf(row: ThreadRow, state: Thread['state']): Thread {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    title: row.title,
    titleSource: row.titleSource,
    posture: row.posture,
    origin: row.origin,
    state,
    hasSession: row.sessionFile !== null,
    forkedFrom: row.forkedFrom,
    pinned: row.pinned,
    archived: row.archived,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

export function createThreadsRepository(db: ModuleDatabase): ThreadsRepository {
  const find = db.prepare<Row>(`SELECT ${COLUMNS} FROM conversation_threads WHERE id = ?`)

  return {
    insert(row) {
      db.prepare(
        `INSERT INTO conversation_threads (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        row.id,
        row.workspaceId,
        row.title,
        row.titleSource,
        row.posture,
        row.origin,
        row.sessionId,
        row.sessionFile,
        row.initialModel?.provider ?? null,
        row.initialModel?.id ?? null,
        row.initialThinking,
        row.forkedFrom,
        row.pinned ? 1 : 0,
        row.archived ? 1 : 0,
        row.createdAt,
        row.updatedAt,
      )
    },
    get(id) {
      const r = find.get(id)
      return r === null || r === undefined ? null : toRow(r)
    },
    list(q) {
      const where: string[] = []
      const params: SqlValue[] = []
      if (q.workspaceId !== undefined) {
        where.push('workspace_id = ?')
        params.push(q.workspaceId)
      }
      if (!q.includeArchived) where.push('archived = 0')
      const sql = `SELECT ${COLUMNS} FROM conversation_threads${where.length > 0 ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY pinned DESC, updated_at DESC`
      return db
        .prepare<Row>(sql)
        .all(...params)
        .map(toRow)
    },
    update(id, patch) {
      const sets: string[] = []
      const params: SqlValue[] = []
      const put = (col: string, value: SqlValue): void => {
        sets.push(`${col} = ?`)
        params.push(value)
      }
      if (patch.workspaceId !== undefined) put('workspace_id', patch.workspaceId)
      if (patch.title !== undefined) put('title', patch.title)
      if (patch.titleSource !== undefined) put('title_source', patch.titleSource)
      if (patch.posture !== undefined) put('posture', patch.posture)
      if (patch.origin !== undefined) put('origin', patch.origin)
      if (patch.sessionId !== undefined) put('session_id', patch.sessionId)
      if (patch.sessionFile !== undefined) put('session_file', patch.sessionFile)
      if (patch.forkedFrom !== undefined) put('forked_from', patch.forkedFrom)
      if (patch.pinned !== undefined) put('pinned', patch.pinned ? 1 : 0)
      if (patch.archived !== undefined) put('archived', patch.archived ? 1 : 0)
      if (patch.initialModel !== undefined) {
        put('initial_model_provider', patch.initialModel?.provider ?? null)
        put('initial_model_id', patch.initialModel?.id ?? null)
      }
      if (patch.initialThinking !== undefined) put('initial_thinking', patch.initialThinking)
      if (patch.createdAt !== undefined) put('created_at', patch.createdAt)
      if (patch.updatedAt !== undefined) put('updated_at', patch.updatedAt)
      if (sets.length === 0) return
      params.push(id)
      db.prepare(`UPDATE conversation_threads SET ${sets.join(', ')} WHERE id = ?`).run(...params)
    },
    delete(id) {
      db.prepare('DELETE FROM conversation_threads WHERE id = ?').run(id)
    },
    listByWorkspace(workspaceId) {
      return db
        .prepare<Row>(
          `SELECT ${COLUMNS} FROM conversation_threads WHERE workspace_id = ? ORDER BY pinned DESC, updated_at DESC`,
        )
        .all(workspaceId)
        .map(toRow)
    },
  }
}
