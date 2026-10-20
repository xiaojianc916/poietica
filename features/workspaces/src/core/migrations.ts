import type { Migration } from '@poietica/storage-sqlite'

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
  {
    /*
     * 「临时会话 / 不在项目中工作」整条概念删除：工作区只剩一个种类，kind 也随之消失。
     * 存量的 scratch 行**一条不删**（它们底下可能挂着真实对话），按普通项目继续可用；
     * 名字改成中性的「项目 <短号>」，不让旧标签继续出现在侧栏里。
     */
    version: 2,
    name: 'drop-kind',
    sql: `CREATE TABLE workspaces_workspaces_v2 (
  id             TEXT PRIMARY KEY,
  path           TEXT NOT NULL,
  path_key       TEXT NOT NULL UNIQUE,
  name           TEXT NOT NULL,
  created_at     INTEGER NOT NULL,
  last_opened_at INTEGER NOT NULL
);
INSERT INTO workspaces_workspaces_v2 (id, path, path_key, name, created_at, last_opened_at)
  SELECT id,
         path,
         path_key,
         CASE WHEN kind = 'scratch' THEN '项目 ' || substr(id, -6) ELSE name END,
         created_at,
         last_opened_at
    FROM workspaces_workspaces;
DROP TABLE workspaces_workspaces;
ALTER TABLE workspaces_workspaces_v2 RENAME TO workspaces_workspaces;
CREATE INDEX workspaces_workspaces_by_opened ON workspaces_workspaces (last_opened_at DESC);`,
  },
]
