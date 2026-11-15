import { createId } from '@poietica/foundation'
import type { ModuleDatabase } from '@poietica/storage-sqlite'
import type { PolicyGrant } from '../contract/entities'

interface Row {
  readonly id: string
  readonly session_key: string
  readonly tool_name: string
  readonly created_at: number
  readonly expires_at: number
}

function toGrant(row: Row): PolicyGrant {
  return {
    id: row.id,
    sessionKey: row.session_key,
    toolName: row.tool_name,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  }
}

export interface PolicyGrantsRepository {
  grant(input: { sessionKey: string; toolName: string; now: number; ttlMs: number }): PolicyGrant
  list(now: number): PolicyGrant[]
  /** 撤销前先读那一条：审计要记下被撤销的是哪个工具、属于哪个会话 */
  find(id: string): PolicyGrant | null
  revoke(id: string): boolean
  isGranted(sessionKey: string, toolName: string, now: number): boolean
}

export function createPolicyGrantsRepository(db: ModuleDatabase): PolicyGrantsRepository {
  const byIdentity = db.prepare<Row>('SELECT * FROM policy_grants WHERE session_key = ? AND tool_name = ?')
  return {
    grant(input) {
      const expiresAt = input.now + input.ttlMs
      const id = createId()
      /*
       * 同一会话同一工具只留一行：重复放行是「延长」而不是「再来一条」，否则授权管理页会列出
       * 一串看不出差别的行，撤销一条还剩一条照样放行。
       */
      db.prepare(
        `INSERT INTO policy_grants (id, session_key, tool_name, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (session_key, tool_name) DO UPDATE SET expires_at = excluded.expires_at`,
      ).run(id, input.sessionKey, input.toolName, input.now, expiresAt)
      const row = byIdentity.get(input.sessionKey, input.toolName)
      return toGrant(row!)
    },
    list(now) {
      return db
        .prepare<Row>('SELECT * FROM policy_grants WHERE expires_at > ? ORDER BY created_at DESC')
        .all(now)
        .map(toGrant)
    },
    find(id) {
      const row = db.prepare<Row>('SELECT * FROM policy_grants WHERE id = ?').get(id)
      return row === undefined || row === null ? null : toGrant(row)
    },
    revoke(id) {
      return db.prepare('DELETE FROM policy_grants WHERE id = ?').run(id).changes > 0
    },
    isGranted(sessionKey, toolName, now) {
      return (
        db
          .prepare<{ one: number }>(
            'SELECT 1 AS one FROM policy_grants WHERE session_key = ? AND tool_name = ? AND expires_at > ?',
          )
          .get(sessionKey, toolName, now) !== null
      )
    },
  }
}
