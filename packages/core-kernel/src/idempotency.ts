import type { Clock } from '@poietica/foundation'
import type { Database } from '@poietica/storage-sqlite'

/** 外部副作用去重：同一 (scope, key) 只记一次结果，重试时直接读回。 */
export interface IdempotencyService {
  get<T = unknown>(scope: string, key: string): T | null
  /** 已存在则保留旧结果并返回 false；否则写入并返回 true。 */
  remember(scope: string, key: string, result: unknown, ttlMs?: number): boolean
  forget(scope: string, key: string): void
}

export interface CreateIdempotencyOptions {
  readonly clock: Clock
  readonly readonly?: boolean
}

const DDL = `
CREATE TABLE IF NOT EXISTS kernel_idempotency (
  scope      TEXT NOT NULL,
  key        TEXT NOT NULL,
  result     TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER,
  PRIMARY KEY (scope, key)
)
`

export function createIdempotency(db: Database, o: CreateIdempotencyOptions): IdempotencyService {
  const readonly = o.readonly === true
  if (!readonly) db.raw.exec(DDL)
  const writable = (): void => {
    if (readonly) throw new Error('只读模式不能写幂等表')
  }

  const prune = (scope: string, key: string): void => {
    const now = o.clock.now()
    db.raw
      .query(
        'DELETE FROM kernel_idempotency WHERE scope = ? AND key = ? AND expires_at IS NOT NULL AND expires_at <= ?',
      )
      .run(scope, key, now)
  }

  return {
    get<T>(scope: string, key: string) {
      prune(scope, key)
      const row = db.raw.query('SELECT result FROM kernel_idempotency WHERE scope = ? AND key = ?').get(scope, key) as {
        result: string
      } | null
      return row === null ? null : (JSON.parse(row.result) as T)
    },
    remember(scope, key, result, ttlMs) {
      writable()
      const now = o.clock.now()
      const inserted = db.raw
        .query(
          'INSERT INTO kernel_idempotency (scope, key, result, created_at, expires_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (scope, key) DO NOTHING',
        )
        .run(scope, key, JSON.stringify(result), now, ttlMs === undefined ? null : now + ttlMs)
      return inserted.changes > 0
    },
    forget(scope, key) {
      writable()
      db.raw.query('DELETE FROM kernel_idempotency WHERE scope = ? AND key = ?').run(scope, key)
    },
  }
}
