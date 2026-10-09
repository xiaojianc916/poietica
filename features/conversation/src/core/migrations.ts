import type { Migration } from '@poietica/storage-sqlite'

/** 表结构照 08 页 §5.2 原样。字段与实体的对应：hasSession = session_file IS NOT NULL；state 不存库 */
export const migrations: readonly Migration[] = [
  {
    version: 1,
    name: 'init',
    sql: `CREATE TABLE conversation_threads (
  id                     TEXT PRIMARY KEY,
  workspace_id           TEXT NOT NULL,
  title                  TEXT NOT NULL,
  title_source           TEXT NOT NULL CHECK (title_source IN ('pending', 'auto', 'user')),
  posture                TEXT NOT NULL,
  origin                 TEXT NOT NULL CHECK (origin IN ('user', 'automation')),
  session_id             TEXT,
  session_file           TEXT,
  initial_model_provider TEXT,
  initial_model_id       TEXT,
  initial_thinking       TEXT,
  forked_from            TEXT,
  pinned                 INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
  archived               INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
  created_at             INTEGER NOT NULL,
  updated_at             INTEGER NOT NULL,
  CHECK ((initial_model_provider IS NULL) = (initial_model_id IS NULL)),
  CHECK ((session_id IS NULL) = (session_file IS NULL))
);
CREATE INDEX conversation_threads_by_workspace ON conversation_threads (workspace_id, archived, pinned DESC, updated_at DESC);
CREATE UNIQUE INDEX conversation_threads_by_session_file ON conversation_threads (session_file) WHERE session_file IS NOT NULL;`,
  },
  {
    version: 2,
    name: 'submissions',
    /*
     * 「Core 即时回显」的提交表：每条提交都有确定结局，并且**存进库**（重开应用也在）。
     * 状态机 pending → started / queued / failed；retry 把 failed 改回 pending（号不变）。
     */
    sql: `CREATE TABLE conversation_submissions (
  client_turn_id   TEXT PRIMARY KEY,
  thread_id        TEXT NOT NULL REFERENCES conversation_threads (id) ON DELETE CASCADE,
  text             TEXT NOT NULL,
  attachments      TEXT NOT NULL,
  skills           TEXT NOT NULL,
  requested_as     TEXT NOT NULL CHECK (requested_as IN ('turn', 'steer', 'followUp')),
  status           TEXT NOT NULL CHECK (status IN ('pending', 'started', 'queued', 'failed')),
  turn_id          TEXT,
  error_code       TEXT,
  error_message    TEXT,
  rev              INTEGER NOT NULL DEFAULT 1,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);
CREATE INDEX conversation_submissions_by_thread ON conversation_submissions (thread_id, created_at);`,
  },
]
