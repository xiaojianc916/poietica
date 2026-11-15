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
  revoke(id: string): boolean
  isGranted(sessionKey: string, toolName: string, now: number): boolean
}

export function createPolicyGrantsRepository(db: ModuleDatabase): PolicyGrantsRepository {
  return {
    grant(input) {
      const expiresAt = input.now + input.ttlMs
      const id = createId()
      db.prepare(
        `INSERT INTO policy_grants (id, session_key, tool_name, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (session_key, tool_name) DO UPDATE SET expires_at = excluded.expires_at`,
      ).run(id, input.sessionKey, input.toolName, input.now, expiresAt)
      const row = db
        .prepare<Row>('SELECT * FROM policy_grants WHERE session_key = ? AND tool_name = ?')
        .get(input.sessionKey, input.toolName)
      return toGrant(row!)
    },
    list(now) {
      return db
        .prepare<Row>('SELECT * FROM policy_grants WHERE expires_at > ? ORDER BY created_at DESC')
        .all(now)
        .map(toGrant)
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
