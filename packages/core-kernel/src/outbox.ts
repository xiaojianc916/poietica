import type { Clock } from '@poietica/foundation'
import type { Database } from '@poietica/storage-sqlite'

export interface OutboxRecord {
  readonly id: number
  readonly topic: string
  readonly payload: unknown
  readonly idempotencyKey: string | null
  readonly attempts: number
}

export interface EnqueueInput {
  readonly topic: string
  readonly payload: unknown
  /** 同一 (topic, key) 只落一行；调用方用它做“至少一次、只生效一次” */
  readonly idempotencyKey?: string
  /** 默认立即可投递 */
  readonly availableAt?: number
}

/**
 * Kernel outbox（ADR-011）：业务写入与 outbox 行在同一事务提交，分发器至少一次投递。
 *
 * 这里只提供原语：enqueue / claim / complete / fail。**它不自己开事务** —— 跨模块调用方
 * 应该在自己的事务里调用 enqueue，这样“写业务表成功”与“事件已排队”同生共死。
 */
export interface OutboxService {
  enqueue(input: EnqueueInput): number
  /** 认领到期且未被租用的行；leaseMs 内不重复投递，超时可被下一次 claim 收回。 */
  claim(limit: number, leaseMs?: number): readonly OutboxRecord[]
  complete(id: number): void
  /** 投递失败：累加重试次数，退避后可再被认领。 */
  fail(id: number, error: string, retryDelayMs?: number): void
  pendingCount(): number
}

export interface CreateOutboxOptions {
  readonly clock: Clock
  /** 只读打开时只建对象、不建表；任何写入都抛错。 */
  readonly readonly?: boolean
}

const DDL = `
CREATE TABLE IF NOT EXISTS kernel_outbox (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  topic           TEXT NOT NULL,
  payload         TEXT NOT NULL,
  idempotency_key TEXT,
  created_at      INTEGER NOT NULL,
  available_at    INTEGER NOT NULL,
  attempts        INTEGER NOT NULL DEFAULT 0,
  claimed_at      INTEGER,
  last_error      TEXT,
  UNIQUE (topic, idempotency_key)
);
CREATE INDEX IF NOT EXISTS kernel_outbox_due ON kernel_outbox (available_at, claimed_at);
`

export function createOutbox(db: Database, o: CreateOutboxOptions): OutboxService {
  const readonly = o.readonly === true
  if (!readonly) db.raw.exec(DDL)

  const ensureWritable = (): void => {
    if (readonly) throw new Error('只读模式不能写 outbox')
  }

  return {
    enqueue(input) {
      ensureWritable()
      const now = o.clock.now()
      const payload = JSON.stringify(input.payload)
      if (input.idempotencyKey === undefined) {
        const result = db.raw
          .query('INSERT INTO kernel_outbox (topic, payload, created_at, available_at) VALUES (?, ?, ?, ?)')
          .run(input.topic, payload, now, input.availableAt ?? now)
        return Number(result.lastInsertRowid)
      }
      db.raw
        .query(
          `INSERT INTO kernel_outbox (topic, payload, idempotency_key, created_at, available_at)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (topic, idempotency_key) DO NOTHING`,
        )
        .run(input.topic, payload, input.idempotencyKey, now, input.availableAt ?? now)
      const row = db.raw
        .query('SELECT id FROM kernel_outbox WHERE topic = ? AND idempotency_key = ?')
        .get(input.topic, input.idempotencyKey) as { id: number }
      return row.id
    },
    claim(limit, leaseMs = 30_000) {
      if (readonly) return []
      const now = o.clock.now()
      const leaseCutoff = now - leaseMs
      const rows = db.raw
        .query(
          `UPDATE kernel_outbox
           SET claimed_at = ?, attempts = attempts + 1
           WHERE id IN (
             SELECT id FROM kernel_outbox
             WHERE available_at <= ? AND (claimed_at IS NULL OR claimed_at < ?)
             ORDER BY id ASC
             LIMIT ?
           )
           RETURNING id, topic, payload, idempotency_key, attempts`,
        )
        .all(now, now, leaseCutoff, Math.max(1, limit)) as {
        id: number
        topic: string
        payload: string
        idempotency_key: string | null
        attempts: number
      }[]
      return rows.map((row) => ({
        id: row.id,
        topic: row.topic,
        payload: JSON.parse(row.payload) as unknown,
        idempotencyKey: row.idempotency_key,
        attempts: row.attempts,
      }))
    },
    complete(id) {
      ensureWritable()
      db.raw.query('DELETE FROM kernel_outbox WHERE id = ?').run(id)
    },
    fail(id, error, retryDelayMs = 30_000) {
      ensureWritable()
      const now = o.clock.now()
      db.raw
        .query('UPDATE kernel_outbox SET claimed_at = NULL, available_at = ?, last_error = ? WHERE id = ?')
        .run(now + Math.max(retryDelayMs, 0), error.slice(0, 2000), id)
    },
    pendingCount() {
      const row = db.raw.query('SELECT COUNT(*) AS n FROM kernel_outbox').get() as { n: number }
      return row.n
    },
  }
}
