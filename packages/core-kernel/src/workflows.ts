import type { Clock } from '@poietica/foundation'
import type { Database } from '@poietica/storage-sqlite'

export type WorkflowState = 'running' | 'done' | 'failed'

export interface WorkflowRecord {
  readonly id: string
  readonly kind: string
  readonly step: string
  readonly state: WorkflowState
  readonly context: unknown
  readonly updatedAt: number
}

export interface WorkflowService {
  /** 幂等启动：同 id 已存在时原样返回，不覆盖进度。 */
  start(input: { id: string; kind: string; step: string; context?: unknown }): WorkflowRecord
  get(id: string): WorkflowRecord | null
  advance(id: string, change: { step: string; state?: WorkflowState; context?: unknown }): WorkflowRecord | null
  /** 启动对账用：进程重启后继续未完成流程。 */
  unfinished(limit?: number): readonly WorkflowRecord[]
}

export interface CreateWorkflowOptions {
  readonly clock: Clock
  readonly readonly?: boolean
}

const DDL = `
CREATE TABLE IF NOT EXISTS kernel_workflows (
  id         TEXT PRIMARY KEY,
  kind       TEXT NOT NULL,
  step       TEXT NOT NULL,
  state      TEXT NOT NULL,
  context    TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS kernel_workflows_unfinished ON kernel_workflows (state, updated_at);
`

interface Row {
  readonly id: string
  readonly kind: string
  readonly step: string
  readonly state: string
  readonly context: string
  readonly updated_at: number
}

export function createWorkflowService(db: Database, o: CreateWorkflowOptions): WorkflowService {
  const readonly = o.readonly === true
  if (!readonly) db.raw.exec(DDL)
  const writable = (): void => {
    if (readonly) throw new Error('只读模式不能写 workflows')
  }

  const fromRow = (row: Row): WorkflowRecord => ({
    id: row.id,
    kind: row.kind,
    step: row.step,
    state: row.state as WorkflowState,
    context: JSON.parse(row.context) as unknown,
    updatedAt: row.updated_at,
  })

  const get = (id: string): WorkflowRecord | null => {
    const row = db.raw.query('SELECT * FROM kernel_workflows WHERE id = ?').get(id) as Row | null
    return row === null ? null : fromRow(row)
  }

  return {
    start(input) {
      writable()
      const exists = get(input.id)
      if (exists !== null) return exists
      const now = o.clock.now()
      db.raw
        .query(
          "INSERT INTO kernel_workflows (id, kind, step, state, context, created_at, updated_at) VALUES (?, ?, ?, 'running', ?, ?, ?)",
        )
        .run(input.id, input.kind, input.step, JSON.stringify(input.context ?? null), now, now)
      return get(input.id)!
    },
    get,
    advance(id, change) {
      writable()
      const current = get(id)
      if (current === null) return null
      db.raw
        .query('UPDATE kernel_workflows SET step = ?, state = ?, context = ?, updated_at = ? WHERE id = ?')
        .run(
          change.step,
          change.state ?? current.state,
          JSON.stringify(change.context ?? current.context),
          o.clock.now(),
          id,
        )
      return get(id)
    },
    unfinished(limit = 100) {
      const rows = db.raw
        .query("SELECT * FROM kernel_workflows WHERE state = 'running' ORDER BY updated_at ASC LIMIT ?")
        .all(Math.max(1, limit)) as Row[]
      return rows.map(fromRow)
    },
  }
}
