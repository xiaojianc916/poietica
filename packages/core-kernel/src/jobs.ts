import type { Clock } from '@poietica/foundation'
import type { Database } from '@poietica/storage-sqlite'

export interface JobRecord {
  readonly id: number
  readonly kind: string
  readonly payload: unknown
  readonly attempts: number
}

export interface KernelJobsService {
  enqueue(input: { kind: string; payload: unknown; availableAt?: number }): number
  /** 认领到期任务；leaseMs 内不重复，超时可被下一次 claim 收回。 */
  claim(limit: number, leaseMs?: number): readonly JobRecord[]
  complete(id: number): void
  /** 失败退避，state 回到 pending。 */
  fail(id: number, error: string, retryDelayMs?: number): void
  count(): number
}

export interface CreateKernelJobsOptions {
  readonly clock: Clock
  readonly readonly?: boolean
}

const DDL = `
CREATE TABLE IF NOT EXISTS kernel_jobs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  kind         TEXT NOT NULL,
  payload      TEXT NOT NULL,
  state        TEXT NOT NULL DEFAULT 'pending',
  attempts     INTEGER NOT NULL DEFAULT 0,
  available_at INTEGER NOT NULL,
  claimed_at   INTEGER,
  last_error   TEXT,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS kernel_jobs_due ON kernel_jobs (state, available_at, claimed_at);
`

export function createKernelJobs(db: Database, o: CreateKernelJobsOptions): KernelJobsService {
  const readonly = o.readonly === true
  if (!readonly) db.raw.exec(DDL)
  const writable = (): void => {
    if (readonly) throw new Error('只读模式不能写 jobs')
  }

  return {
    enqueue(input) {
      writable()
      const now = o.clock.now()
      const result = db.raw
        .query(
          "INSERT INTO kernel_jobs (kind, payload, state, available_at, created_at, updated_at) VALUES (?, ?, 'pending', ?, ?, ?)",
        )
        .run(input.kind, JSON.stringify(input.payload), input.availableAt ?? now, now, now)
      return Number(result.lastInsertRowid)
    },
    claim(limit, leaseMs = 60_000) {
      if (readonly) return []
      const now = o.clock.now()
      const rows = db.raw
        .query(
          `UPDATE kernel_jobs
           SET state = 'running', claimed_at = ?, attempts = attempts + 1, updated_at = ?
           WHERE id IN (
             SELECT id FROM kernel_jobs
             WHERE state = 'pending' AND available_at <= ?
                OR (state = 'running' AND claimed_at < ?)
             ORDER BY id ASC
             LIMIT ?
           )
           RETURNING id, kind, payload, attempts`,
        )
        .all(now, now, now, now - leaseMs, Math.max(1, limit)) as {
        id: number
        kind: string
        payload: string
        attempts: number
      }[]
      return rows.map((row) => ({
        id: row.id,
        kind: row.kind,
        payload: JSON.parse(row.payload) as unknown,
        attempts: row.attempts,
      }))
    },
    complete(id) {
      writable()
      db.raw.query("UPDATE kernel_jobs SET state = 'done', updated_at = ? WHERE id = ?").run(o.clock.now(), id)
    },
    fail(id, error, retryDelayMs = 30_000) {
      writable()
      const now = o.clock.now()
      db.raw
        .query(
          "UPDATE kernel_jobs SET state = 'pending', claimed_at = NULL, available_at = ?, last_error = ?, updated_at = ? WHERE id = ?",
        )
        .run(now + Math.max(0, retryDelayMs), error.slice(0, 2000), now, id)
    },
    count() {
      const row = db.raw.query("SELECT COUNT(*) AS n FROM kernel_jobs WHERE state IN ('pending', 'running')").get() as {
        n: number
      }
      return row.n
    },
  }
}
