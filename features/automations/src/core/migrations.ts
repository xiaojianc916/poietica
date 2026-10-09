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
]
