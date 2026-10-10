import type { Migration } from '@poietica/storage-sqlite'

/** DDL 照 08 页 §5.4 原样；列名 triggered_by 避开 SQL 关键字，实体字段名仍是 trigger */
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
  CHECK ((model_provider IS NULL) = (model_id IS NULL))
);
CREATE INDEX automations_automations_due ON automations_automations (enabled, next_run_at) WHERE issue IS NULL;
CREATE TABLE automations_runs (
  id            TEXT PRIMARY KEY,
  automation_id TEXT NOT NULL REFERENCES automations_automations (id) ON DELETE CASCADE,
  thread_id     TEXT,
  triggered_by  TEXT NOT NULL CHECK (triggered_by IN ('schedule', 'manual')),
  scheduled_for INTEGER,
  started_at    INTEGER NOT NULL,
  settled_at    INTEGER,
  outcome       TEXT NOT NULL CHECK (outcome IN ('running', 'awaiting', 'succeeded', 'failed', 'cancelled')),
  message       TEXT
);
CREATE INDEX automations_runs_by_automation ON automations_runs (automation_id, started_at DESC);
CREATE INDEX automations_runs_open ON automations_runs (outcome) WHERE outcome IN ('running', 'awaiting');`,
  },
  {
    /*
     * 审查 R-14：一次性计划（run_at）、续用对话（thread_mode / thread_id）、通知策略（notify）、
     * 错过补跑（catch_up）；运行记录加 agent 汇报（summary / attention）、触发方式 catch_up、
     * 结局 skipped。SQLite 改不了已有列的 CHECK，所以运行表整张重建（行原样搬过去）。
     */
    version: 2,
    name: 'r14-automation-upgrade',
    sql: `ALTER TABLE automations_automations ADD COLUMN run_at INTEGER;
ALTER TABLE automations_automations ADD COLUMN thread_mode TEXT NOT NULL DEFAULT 'new' CHECK (thread_mode IN ('new', 'continue'));
ALTER TABLE automations_automations ADD COLUMN thread_id TEXT;
ALTER TABLE automations_automations ADD COLUMN notify TEXT NOT NULL DEFAULT 'attention' CHECK (notify IN ('always', 'attention', 'never'));
ALTER TABLE automations_automations ADD COLUMN catch_up INTEGER NOT NULL DEFAULT 1 CHECK (catch_up IN (0, 1));
CREATE TABLE automations_runs_v2 (
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
INSERT INTO automations_runs_v2
  (id, automation_id, thread_id, triggered_by, scheduled_for, started_at, settled_at, outcome, message, summary, attention)
  SELECT id, automation_id, thread_id, triggered_by, scheduled_for, started_at, settled_at, outcome, message, NULL, 0
  FROM automations_runs;
DROP TABLE automations_runs;
ALTER TABLE automations_runs_v2 RENAME TO automations_runs;
CREATE INDEX automations_runs_by_automation ON automations_runs (automation_id, started_at DESC);
CREATE INDEX automations_runs_open ON automations_runs (outcome) WHERE outcome IN ('running', 'awaiting');
CREATE INDEX automations_runs_by_thread ON automations_runs (thread_id) WHERE thread_id IS NOT NULL;`,
  },
]
