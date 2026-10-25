import type { Migration } from '@poietica/storage-sqlite'

/**
 * 当前 schema（一条 init 建完）。字段与实体的对应：hasSession = session_file IS NOT NULL；state 不存库。
 *
 * 三张表各管一件事实：
 * - conversation_threads：线程行。omp 的会话 id / 文件两者同时为空或同时有值（CHECK），只在线程服务一处一起写；
 * - conversation_submissions：每条提交都有确定结局并存进库（重开应用也在）。状态机 pending → started / queued / failed；
 *   retry 把 failed 改回 pending（号不变）；外键随线程级联删除；
 * - conversation_reclaim：会话文件回收队列。删一条线程要动两处存储（库里的行、omp 目录里的会话文件），
 *   两者没有共同事务，所以删行与「这份文件待回收」在同一个库事务里落账，文件删除在事务之后尝试、失败留待下次启动重试；
 *   此刻线程行已经不在了，因此不挂外键。
 *
 * 索引都是读路径要的形状：侧栏按（工作区, 归档, 置顶, 活动时间）取；会话文件唯一（同一份文件只属于一条线程）；
 * 提交按线程按时间取整串；取号表只收已开出轮的提交（turn_id 非空），三列都在索引里，取号表不回表、认号直接定位。
 */
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
  controls_snapshot      TEXT,
  CHECK ((initial_model_provider IS NULL) = (initial_model_id IS NULL)),
  CHECK ((session_id IS NULL) = (session_file IS NULL))
);
CREATE INDEX conversation_threads_by_workspace ON conversation_threads (workspace_id, archived, pinned DESC, updated_at DESC);
CREATE UNIQUE INDEX conversation_threads_by_session_file ON conversation_threads (session_file) WHERE session_file IS NOT NULL;
CREATE TABLE conversation_submissions (
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
CREATE INDEX conversation_submissions_by_thread ON conversation_submissions (thread_id, created_at);
CREATE INDEX conversation_submissions_by_turn ON conversation_submissions (thread_id, turn_id, client_turn_id) WHERE turn_id IS NOT NULL;
CREATE TABLE conversation_reclaim (
  session_file TEXT PRIMARY KEY,
  thread_id    TEXT NOT NULL,
  attempts     INTEGER NOT NULL DEFAULT 0,
  last_error   TEXT,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);`,
  },
]
