import type { Migration } from '@poietica/storage-sqlite'

/** DDL 照 08 页 §5.3 原样（三张表：内容、条目、引用） */
export const migrations: readonly Migration[] = [
  {
    version: 1,
    name: 'init',
    sql: `CREATE TABLE attachments_files (
  sha256     TEXT PRIMARY KEY CHECK (length(sha256) = 64),
  size       INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE attachments_items (
  id         TEXT PRIMARY KEY,
  sha256     TEXT NOT NULL REFERENCES attachments_files (sha256),
  name       TEXT NOT NULL,
  mime       TEXT NOT NULL,
  kind       TEXT NOT NULL CHECK (kind IN ('image', 'file')),
  created_at INTEGER NOT NULL
);
CREATE INDEX attachments_items_by_sha ON attachments_items (sha256);
CREATE TABLE attachments_refs (
  owner_key  TEXT NOT NULL,
  item_id    TEXT NOT NULL REFERENCES attachments_items (id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (owner_key, item_id)
) WITHOUT ROWID;
CREATE INDEX attachments_refs_by_item ON attachments_refs (item_id);`,
  },
]
