import type { Migration } from '@poietica/storage-sqlite'

/**
 * 当前 schema（一条 init 建完）。工作区只有一种：磁盘上的一个项目目录。
 * path_key 是归一化后的路径（大小写、分隔符），UNIQUE 保证同一目录只登记一次；
 * 侧栏按 last_opened_at 倒序，索引跟着这个读法走。
 */
export const migrations: readonly Migration[] = [
  {
    version: 1,
    name: 'init',
    sql: `CREATE TABLE workspaces_workspaces (
  id             TEXT PRIMARY KEY,
  path           TEXT NOT NULL,
  path_key       TEXT NOT NULL UNIQUE,
  name           TEXT NOT NULL,
  created_at     INTEGER NOT NULL,
  last_opened_at INTEGER NOT NULL
);
CREATE INDEX workspaces_workspaces_by_opened ON workspaces_workspaces (last_opened_at DESC);`,
  },
]
