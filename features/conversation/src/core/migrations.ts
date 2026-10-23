import type { Migration } from '@poietica/storage-sqlite'

/** 字段与实体的对应：hasSession = session_file IS NOT NULL；state 不存库 */
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
     * 提交表：每条提交都有确定结局并存进库（重开应用也在）。状态机 pending → started / queued / failed；
     * retry 把 failed 改回 pending（号不变）。
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
  {
    version: 3,
    name: 'submissions_cleanup',
    /*
     * 一次性清旧账（审查 R-20-1）。升级前 `queued` 从来没有收口，每次 Core 启动都把早已送达、早已答复的
     * 排队句改成 failed / core_restarted；整读时「最后一条失败」又把它们复活成「提交未完成」横幅。
     * 1. 还停在 queued 的、以及 core_restarted 的失败行：绝大多数是送达过的排队句，删掉；
     * 2. 同线程里**更晚**还有非失败提交的失败行：用户已经接着往下说了，这条失败到此为止（与新代码的
     *    `supersedeFailed` 同一条规矩）。
     */
    sql: `DELETE FROM conversation_submissions
 WHERE status = 'queued'
    OR (status = 'failed' AND error_code = 'conversation.core_restarted');
DELETE FROM conversation_submissions
 WHERE status = 'failed'
   AND EXISTS (
     SELECT 1 FROM conversation_submissions AS later
      WHERE later.thread_id = conversation_submissions.thread_id
        AND later.status <> 'failed'
        AND (later.created_at > conversation_submissions.created_at
          OR (later.created_at = conversation_submissions.created_at
            AND later.client_turn_id > conversation_submissions.client_turn_id))
   );`,
  },
  {
    version: 4,
    name: 'reclaim',
    /*
     * 会话文件回收队列（「先记账，后动手」）。删除一条线程要动两处存储：库里的行、omp 目录里的会话文件。
     * 两者没有共同的事务，原先按「先删文件、再删行」串着做，任何一步失败都把线程卡在半删状态、之后永远删不掉。
     * 现在删行与「这份文件待回收」在同一个库事务里落账；文件删除在事务之后尝试，失败留在这里，下次启动重试。
     * 不挂外键：线程行此刻已经不在了。
     */
    sql: `CREATE TABLE conversation_reclaim (
  session_file TEXT PRIMARY KEY,
  thread_id    TEXT NOT NULL,
  attempts     INTEGER NOT NULL DEFAULT 0,
  last_error   TEXT,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
);`,
  },
  {
    version: 5,
    name: 'controls_snapshot',
    /*
     * 控件表快照（性能方案 P4，见 controls-snapshot.ts）：看一条没开着的对话时，输入框那一排选择器照它画，
     * 不为一张控件表去打开会话。活会话每报一次控件表、上下文用量就覆盖一次；随行删除，不必另外清理。
     * 升级前的线程没有这一格：第一次看时照旧打开会话现问，打开时写进来，此后就是冷读。
     */
    sql: `ALTER TABLE conversation_threads ADD COLUMN controls_snapshot TEXT;`,
  },
  {
    version: 6,
    name: 'submissions_by_turn',
    /*
     * 提交号表（数据库性能方案 D2）：每次订阅时间线、每翻一页快照都要按线程取一张 `turnId → clientTurnId`，
     * 流式期间每个新 turn 还要按 `(thread_id, turn_id)` 认一次号。原先只有 `(thread_id, created_at)`，两处都得回表读整行。
     * 部分索引只收已经开出轮的行（pending / queued / failed 没有 turn_id），三列都在索引里：取号表不回表，认号直接定位。
     */
    sql: `CREATE INDEX conversation_submissions_by_turn ON conversation_submissions (thread_id, turn_id, client_turn_id) WHERE turn_id IS NOT NULL;`,
  },
]
