import type { Migration } from '@poietica/storage-sqlite'

/**
 * 当前 schema（一条 init 建完）。
 *
 * - automations_automations：一条定时任务。计划二选一（cron 或 run_at），另带时区；thread_mode 决定每次新开对话还是续用
 *   一条（续用时 thread_id 记着那条对话）；notify 决定跑完要不要提醒、catch_up 决定错过的那几次要不要补跑。
 * - automations_runs：每次运行一行。trigger 记这一次是怎么来的（排到的 / 手动 / 补跑），outcome 是结局
 *   （skipped 是补跑时判定「这一次不必跑」）；summary 与 attention 是跑完后给界面与提醒用的两份结论。
 *
 * 三个索引对应三条读路径：排程扫描只看「启用、没毛病、到点」的任务（部分索引）；历史按任务按时间倒序取；
 * 关掉线程时按 thread_id 找回还开着的运行（部分索引，只收 running / awaiting）。
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
]
