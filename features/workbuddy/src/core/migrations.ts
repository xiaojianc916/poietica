import type { Migration } from '@poietica/storage-sqlite'

/**
 * 一条 init 建完。账号是这份功能唯一的事实：
 * - access / refresh 是 WorkBuddy 的令牌；api_key 只在 API Key 账号里非空。
 * - usage_json 是最近一次上游积分快照，页面重开时先显示它，再刷新。
 * - last_checkin_day 是本地日期（YYYY-MM-DD），自动签到一天只跑一次。
 * - status 只记账号层面的结论（ok / expired / error），不把上游原文当状态。
 */
export const migrations: readonly Migration[] = [
  {
    version: 1,
    name: 'init',
    sql: `CREATE TABLE workbuddy_accounts (
  id                   TEXT PRIMARY KEY,
  label                TEXT NOT NULL,
  auth_type            TEXT NOT NULL CHECK (auth_type IN ('oauth', 'api')),
  access               TEXT NOT NULL,
  refresh              TEXT NOT NULL DEFAULT '',
  expires              INTEGER NOT NULL DEFAULT 0,
  refresh_expires_at   INTEGER NOT NULL DEFAULT 0,
  uid                  TEXT NOT NULL DEFAULT '',
  domain               TEXT NOT NULL DEFAULT '',
  token_type           TEXT NOT NULL DEFAULT '',
  enterprise_id        TEXT NOT NULL DEFAULT '',
  api_key              TEXT NOT NULL DEFAULT '',
  plan                 TEXT NOT NULL DEFAULT '',
  status               TEXT NOT NULL DEFAULT 'ok' CHECK (status IN ('ok', 'expired', 'error')),
  status_message       TEXT,
  usage_json           TEXT,
  usage_at             INTEGER,
  last_checkin_day     TEXT,
  last_checkin_at      INTEGER,
  last_checkin_outcome TEXT,
  last_checkin_message TEXT,
  last_checkin_credit  REAL,
  last_checkin_streak  INTEGER,
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL
);
CREATE INDEX workbuddy_accounts_uid ON workbuddy_accounts (uid);
CREATE TABLE workbuddy_settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);`,
  },
]
