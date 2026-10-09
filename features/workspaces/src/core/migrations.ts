import type { Migration } from '@poietica/storage-sqlite'

/** DDL 照 08 页 §5.1 原样 */
export const migrations: readonly Migration[] = [
  {
    version: 1,
    name: 'init',
    sql: `CREATE TABLE workspaces_workspaces (
  id             TEXT PRIMARY KEY,
  kind           TEXT NOT NULL CHECK (kind IN ('folder', 'scratch')),
  path           TEXT NOT NULL,
  path_key       TEXT NOT NULL UNIQUE,
  name           TEXT NOT NULL,
  created_at     INTEGER NOT NULL,
  last_opened_at INTEGER NOT NULL
);
CREATE INDEX workspaces_workspaces_by_opened ON workspaces_workspaces (last_opened_at DESC);`,
  },
]
