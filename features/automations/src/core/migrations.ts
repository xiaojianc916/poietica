import type { Migration } from '@poietica/storage-sqlite'

/**
 * 当前 schema（一条 init 建完）。
 *
 * - automations_automations：一条定时任务。计划二选一（cron 或 run_at），另带时区；thread_mode 决定每次新开对话还是续用
 *   一条（续用时 thread_id 记着那条对话）；notify 决定跑完要不要提醒、catch_up 决定错过的那几次要不要补跑。
 * - automations_runs：每次运行一行。trigger 记这一次是怎么来的（排到的 / 手动 / 补跑），outcome 是结局
 *   （skipped 是补跑时判定「这一次不必跑」）；summary 与 attention 是跑完后给界面与提醒用的两份结论。
 *
 * 四个索引对应四条读路径：排程扫描只看「启用、没毛病、到点」的任务（部分索引）；认领回收按 claimed_at；
 * 历史按任务按时间倒序取；关掉线程时按 thread_id 找回还开着的运行（部分索引，只收 running / awaiting）。
 *
 * v2 是增量列，不改 v1 的建表语句：派发租约（claimed_at / dispatch_* / retry_at / last_error）与幂等运行台账
 * （dispatch_status / attempts）由 ZCode 的调度模型移植而来，旧数据按「已派发」回填，不重跑历史窗口。
 * v3 再加自定义重复规则（schedule_rule 存 JSON）与有限次/截止（max_runs / end_at）；cron 列继续保留作兼容展示。
 */
export const migrations: readonly Migration[] = [
  {
    version: 1,
    name: 'init',
    sql: `CREATE TABLE automations_automations (
  id             TEXT PRIMARY KEY,
  title          TEXT NOT NULL,
  prompt         TEXT NOT NULL,
  cron           TEXT,
  time_zone      TEXT NOT NULL,
  workspace_id   TEXT NOT NULL,
  posture        TEXT NOT NULL,
  model_provider TEXT,
  model_id       TEXT,
  thinking       TEXT,
  enabled        INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  next_run_at    INTEGER,
  issue          TEXT,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  run_at         INTEGER,
  thread_mode    TEXT NOT NULL DEFAULT 'new' CHECK (thread_mode IN ('new', 'continue')),
  thread_id      TEXT,
  notify         TEXT NOT NULL DEFAULT 'attention' CHECK (notify IN ('always', 'attention', 'never')),
  catch_up       INTEGER NOT NULL DEFAULT 1 CHECK (catch_up IN (0, 1)),
  CHECK ((model_provider IS NULL) = (model_id IS NULL))
);
CREATE INDEX automations_automations_due ON automations_automations (enabled, next_run_at) WHERE issue IS NULL;
CREATE TABLE automations_runs (
  id            TEXT PRIMARY KEY,
  automation_id TEXT NOT NULL REFERENCES automations_automations (id) ON DELETE CASCADE,
  thread_id     TEXT,
  triggered_by  TEXT NOT NULL CHECK (triggered_by IN ('schedule', 'manual', 'catch_up')),
  scheduled_for INTEGER,
  started_at    INTEGER NOT NULL,
  settled_at    INTEGER,
  outcome       TEXT NOT NULL CHECK (outcome IN ('running', 'awaiting', 'succeeded', 'failed', 'cancelled', 'skipped')),
  message       TEXT,
  summary       TEXT,
  attention     INTEGER NOT NULL DEFAULT 0 CHECK (attention IN (0, 1))
);
CREATE INDEX automations_runs_by_automation ON automations_runs (automation_id, started_at DESC);
CREATE INDEX automations_runs_open ON automations_runs (outcome) WHERE outcome IN ('running', 'awaiting');
CREATE INDEX automations_runs_by_thread ON automations_runs (thread_id) WHERE thread_id IS NOT NULL;`,
  },
  {
    version: 2,
    name: 'dispatch-ledger',
    sql: `ALTER TABLE automations_automations ADD COLUMN run_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE automations_automations ADD COLUMN dispatch_status TEXT NOT NULL DEFAULT 'idle';
ALTER TABLE automations_automations ADD COLUMN dispatch_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE automations_automations ADD COLUMN retry_at INTEGER;
ALTER TABLE automations_automations ADD COLUMN last_error TEXT;
ALTER TABLE automations_automations ADD COLUMN claimed_at INTEGER;
ALTER TABLE automations_runs ADD COLUMN dispatch_status TEXT NOT NULL DEFAULT 'dispatched';
ALTER TABLE automations_runs ADD COLUMN attempts INTEGER NOT NULL DEFAULT 1;
UPDATE automations_automations SET run_count = (
  SELECT COUNT(*) FROM automations_runs r
  WHERE r.automation_id = automations_automations.id
    AND r.outcome IN ('running', 'awaiting', 'succeeded', 'failed', 'cancelled')
);
CREATE INDEX automations_automations_retry ON automations_automations (enabled, retry_at);
CREATE INDEX automations_automations_claimed ON automations_automations (claimed_at) WHERE claimed_at IS NOT NULL;`,
  },
  {
    version: 3,
    name: 'schedule-rule-limits',
    sql: `ALTER TABLE automations_automations ADD COLUMN schedule_rule TEXT;
ALTER TABLE automations_automations ADD COLUMN max_runs INTEGER;
ALTER TABLE automations_automations ADD COLUMN end_at INTEGER;`,
  },
]
