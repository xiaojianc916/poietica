import type { Migration } from '@poietica/storage-sqlite'

/**
 * 账号是这份功能唯一的事实：
 * - access / refresh 是 WorkBuddy 的令牌；api_key 只在 API Key 账号里非空。
 * - usage_json 是最近一次上游积分快照，页面重开时先显示它，再刷新。
 * - last_checkin_day 是北京时间日期（YYYY-MM-DD），自动签到一天只跑一次。
 * - status 只记账号层面的结论（ok / expired / error），不把上游原文当状态。
 * - rest_until 是「这个号暂时别用」的截止时刻：上游说它受限 / 没额度 / 被限流时让它歇一会儿，
 *   不歇就会拿它一遍遍重试，把一次限流拖成整段不可用。
 * - last_checkin_next_try_at 是签到失败后的下次重试时刻：签到一天只算一次，但「没问出结果」
 *   和「今天不用再问」是两件事，不分开就只能每小时问一遍。
 *
 * 这两组列走 v2 追加，不改 v1：已经跑过 v1 的库不会再执行它，改它会让指纹对不上
 * （SchemaDriftError，退出码 5；见 packages/storage-sqlite/src/migrations.ts 与偏差 #82）。
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
  {
    version: 2,
    name: 'account-rest-and-checkin-retry',
    sql: `ALTER TABLE workbuddy_accounts ADD COLUMN rest_until INTEGER NOT NULL DEFAULT 0;
ALTER TABLE workbuddy_accounts ADD COLUMN rest_reason TEXT;
ALTER TABLE workbuddy_accounts ADD COLUMN last_checkin_next_try_at INTEGER NOT NULL DEFAULT 0;`,
  },
]
