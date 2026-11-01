import type { ModuleDatabase } from '@poietica/storage-sqlite'

export interface AccountCheckinRecord {
  readonly day: string
  readonly at: number
  readonly outcome: string
  readonly message: string | null
  readonly credit: number | null
  readonly streak: number | null
}

export interface AccountRecord {
  readonly id: string
  readonly label: string
  readonly authType: 'oauth' | 'api'
  readonly access: string
  readonly refresh: string
  readonly expires: number
  readonly refreshExpiresAt: number
  readonly uid: string
  readonly domain: string
  readonly tokenType: string
  readonly enterpriseId: string
  readonly apiKey: string
  readonly plan: string
  readonly status: 'ok' | 'expired' | 'error'
  readonly statusMessage: string | null
  readonly usageJson: string | null
  readonly usageAt: number | null
  readonly checkin: AccountCheckinRecord | null
  readonly createdAt: number
  readonly updatedAt: number
}

interface AccountRow {
  readonly id: string
  readonly label: string
  readonly authType: 'oauth' | 'api'
  readonly access: string
  readonly refresh: string
  readonly expires: number
  readonly refreshExpiresAt: number
  readonly uid: string
  readonly domain: string
  readonly tokenType: string
  readonly enterpriseId: string
  readonly apiKey: string
  readonly plan: string
  readonly status: 'ok' | 'expired' | 'error'
  readonly statusMessage: string | null
  readonly usageJson: string | null
  readonly usageAt: number | null
  readonly lastCheckinDay: string | null
  readonly lastCheckinAt: number | null
  readonly lastCheckinOutcome: string | null
  readonly lastCheckinMessage: string | null
  readonly lastCheckinCredit: number | null
  readonly lastCheckinStreak: number | null
  readonly createdAt: number
  readonly updatedAt: number
}

const COLUMNS = `id, label, auth_type AS authType, access, refresh, expires, refresh_expires_at AS refreshExpiresAt,
  uid, domain, token_type AS tokenType, enterprise_id AS enterpriseId, api_key AS apiKey, plan, status,
  status_message AS statusMessage, usage_json AS usageJson, usage_at AS usageAt,
  last_checkin_day AS lastCheckinDay, last_checkin_at AS lastCheckinAt, last_checkin_outcome AS lastCheckinOutcome,
  last_checkin_message AS lastCheckinMessage, last_checkin_credit AS lastCheckinCredit, last_checkin_streak AS lastCheckinStreak,
  created_at AS createdAt, updated_at AS updatedAt`

function toRecord(row: AccountRow): AccountRecord {
  return {
    id: row.id,
    label: row.label,
    authType: row.authType,
    access: row.access,
    refresh: row.refresh,
    expires: row.expires,
    refreshExpiresAt: row.refreshExpiresAt,
    uid: row.uid,
    domain: row.domain,
    tokenType: row.tokenType,
    enterpriseId: row.enterpriseId,
    apiKey: row.apiKey,
    plan: row.plan,
    status: row.status,
    statusMessage: row.statusMessage,
    usageJson: row.usageJson,
    usageAt: row.usageAt,
    checkin:
      row.lastCheckinDay === null || row.lastCheckinAt === null || row.lastCheckinOutcome === null
        ? null
        : {
            day: row.lastCheckinDay,
            at: row.lastCheckinAt,
            outcome: row.lastCheckinOutcome,
            message: row.lastCheckinMessage,
            credit: row.lastCheckinCredit,
            streak: row.lastCheckinStreak,
          },
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

export interface AccountAuthPatch {
  readonly authType: 'oauth' | 'api'
  readonly access: string
  readonly refresh: string
  readonly expires: number
  readonly refreshExpiresAt: number
  readonly uid: string
  readonly domain: string
  readonly tokenType: string
  readonly enterpriseId: string
  readonly apiKey: string
}

export interface WorkBuddyRepository {
  list(): AccountRecord[]
  get(id: string): AccountRecord | null
  findByIdentity(uid: string, label: string): AccountRecord | null
  insert(record: AccountRecord): void
  updateAuth(id: string, patch: AccountAuthPatch, now: number): void
  updateIdentity(id: string, label: string, uid: string, plan: string, now: number): void
  updateUsage(id: string, plan: string, usageJson: string, usageAt: number, now: number): void
  updateCheckin(id: string, checkin: AccountCheckinRecord, now: number): void
  setStatus(id: string, status: AccountRecord['status'], message: string | null, now: number): void
  remove(id: string): void
  settings(): Record<string, string>
  setSetting(key: string, value: string): void
}

export function createWorkBuddyRepository(db: ModuleDatabase): WorkBuddyRepository {
  return {
    list() {
      const rows = db
        .prepare<AccountRow>(`SELECT ${COLUMNS} FROM workbuddy_accounts ORDER BY created_at ASC`)
        .all() as AccountRow[]
      return rows.map(toRecord)
    },
    get(id) {
      const row = db
        .prepare<AccountRow>(`SELECT ${COLUMNS} FROM workbuddy_accounts WHERE id = ?`)
        .get(id) as AccountRow | null
      return row === null ? null : toRecord(row)
    },
    findByIdentity(uid, label) {
      const row = db
        .prepare<AccountRow>(
          `SELECT ${COLUMNS} FROM workbuddy_accounts WHERE uid = ? AND label = ? ORDER BY created_at ASC LIMIT 1`,
        )
        .get(uid, label) as AccountRow | null
      return row === null ? null : toRecord(row)
    },
    insert(record) {
      db.prepare(
        `INSERT INTO workbuddy_accounts (
          id, label, auth_type, access, refresh, expires, refresh_expires_at, uid, domain, token_type,
          enterprise_id, api_key, plan, status, status_message, usage_json, usage_at,
          last_checkin_day, last_checkin_at, last_checkin_outcome, last_checkin_message,
          last_checkin_credit, last_checkin_streak, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        record.id,
        record.label,
        record.authType,
        record.access,
        record.refresh,
        record.expires,
        record.refreshExpiresAt,
        record.uid,
        record.domain,
        record.tokenType,
        record.enterpriseId,
        record.apiKey,
        record.plan,
        record.status,
        record.statusMessage,
        record.usageJson,
        record.usageAt,
        record.checkin?.day ?? null,
        record.checkin?.at ?? null,
        record.checkin?.outcome ?? null,
        record.checkin?.message ?? null,
        record.checkin?.credit ?? null,
        record.checkin?.streak ?? null,
        record.createdAt,
        record.updatedAt,
      )
    },
    updateAuth(id, patch, now) {
      db.prepare(
        `UPDATE workbuddy_accounts SET auth_type = ?, access = ?, refresh = ?, expires = ?, refresh_expires_at = ?,
          uid = ?, domain = ?, token_type = ?, enterprise_id = ?, api_key = ?, updated_at = ? WHERE id = ?`,
      ).run(
        patch.authType,
        patch.access,
        patch.refresh,
        patch.expires,
        patch.refreshExpiresAt,
        patch.uid,
        patch.domain,
        patch.tokenType,
        patch.enterpriseId,
        patch.apiKey,
        now,
        id,
      )
    },
    updateIdentity(id, label, uid, plan, now) {
      db.prepare('UPDATE workbuddy_accounts SET label = ?, uid = ?, plan = ?, updated_at = ? WHERE id = ?').run(
        label,
        uid,
        plan,
        now,
        id,
      )
    },
    updateUsage(id, plan, usageJson, usageAt, now) {
      db.prepare(
        'UPDATE workbuddy_accounts SET plan = ?, usage_json = ?, usage_at = ?, updated_at = ? WHERE id = ?',
      ).run(plan, usageJson, usageAt, now, id)
    },
    updateCheckin(id, checkin, now) {
      db.prepare(
        `UPDATE workbuddy_accounts SET last_checkin_day = ?, last_checkin_at = ?, last_checkin_outcome = ?,
          last_checkin_message = ?, last_checkin_credit = ?, last_checkin_streak = ?, updated_at = ? WHERE id = ?`,
      ).run(checkin.day, checkin.at, checkin.outcome, checkin.message, checkin.credit, checkin.streak, now, id)
    },
    setStatus(id, status, message, now) {
      db.prepare('UPDATE workbuddy_accounts SET status = ?, status_message = ?, updated_at = ? WHERE id = ?').run(
        status,
        message,
        now,
        id,
      )
    },
    remove(id) {
      db.prepare('DELETE FROM workbuddy_accounts WHERE id = ?').run(id)
    },
    settings() {
      const rows = db.prepare<{ key: string; value: string }>('SELECT key, value FROM workbuddy_settings').all() as {
        key: string
        value: string
      }[]
      const out: Record<string, string> = {}
      for (const row of rows) out[row.key] = row.value
      return out
    },
    setSetting(key, value) {
      db.prepare(
        'INSERT INTO workbuddy_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
      ).run(key, value)
    },
  }
}
