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
]
