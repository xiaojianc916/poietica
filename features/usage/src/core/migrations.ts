import type { Migration } from '@poietica/storage-sqlite'

/*
 * DDL 照 08 页 §5 原样（usage_events 一表）。
 *
 * v2 是 2026-10-07 的修正：08 页给的 `messageCount` 口径是「一次模型调用 = 一条消息」
 * （数 usage_events 的行），而 legacy 与 ADR 0039 的口径是**用户发出去的句子数**——
 * 两者相差一个数量级（一次用户输入会引出多次模型调用），屏幕上的数字对不上。
 * 按产品负责人裁决改回 legacy 口径：另立一张按天的准入账，不去猜哪些采样属于同一次输入。
 */
export const migrations: readonly Migration[] = [
  {
    version: 1,
    name: 'init',
    sql: `CREATE TABLE usage_events (
  id          INTEGER PRIMARY KEY,
  thread_id   TEXT NOT NULL,                                    -- 无外键；线程删除后保留
  day         TEXT NOT NULL,                                    -- Core 本地时区日期 YYYY-MM-DD
  at          INTEGER NOT NULL,
  provider    TEXT NOT NULL,
  model       TEXT NOT NULL,
  input       INTEGER NOT NULL,
  output      INTEGER NOT NULL,
  cache_read  INTEGER NOT NULL,
  cache_write INTEGER NOT NULL,
  cost        REAL NOT NULL
);
CREATE INDEX usage_events_by_day ON usage_events (day);
CREATE INDEX usage_events_by_thread ON usage_events (thread_id);`,
  },
  {
    version: 2,
    name: 'messages',
    sql: `CREATE TABLE usage_messages (
  id INTEGER PRIMARY KEY,
  thread_id TEXT NOT NULL,
  day TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX usage_messages_by_day ON usage_messages (day);`,
  },
]
