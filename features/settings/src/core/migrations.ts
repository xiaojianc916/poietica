import type { Migration } from '@poietica/storage-sqlite'

export const migrations: readonly Migration[] = [
  {
    version: 1,
    name: 'create-settings-values',
    sql: `CREATE TABLE IF NOT EXISTS settings_values (
      scope      TEXT NOT NULL,
      scope_id   TEXT NOT NULL,
      key        TEXT NOT NULL,
      value      TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (scope, scope_id, key)
    )`,
  },
  {
    /* 只读档已从产品删除（2026-11-22）：全局策略预设里若还留着 'read-only'，改到最接近的「每次询问」。 */
    version: 2,
    name: 'drop-read-only-policy-preset',
    sql: `UPDATE settings_values SET value = '"ask"' WHERE key = 'policy.preset' AND value = '"read-only"';`,
  },
]
