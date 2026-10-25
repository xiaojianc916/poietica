import type { Migration } from '@poietica/storage-sqlite'

/**
 * 当前 schema（一条 init 建完）。两张账、一张汇总：
 *
 * - usage_events：原始采样账，一次模型调用一行，只增不减；要重算汇总时从它 GROUP BY 一遍。没有索引 ——
 *   没有任何查询按它过滤（读的一侧只碰 usage_daily），每条采样少写两棵 B 树；
 * - usage_messages：按天的准入账，用户发出去一句记一行（插话也算）。消息数数的是它，不是采样条数：
 *   一次用户输入会引出多次模型调用，按采样数会把「消息数量」放大约一个数量级（ADR 0039）；
 * - usage_daily：按（天, 供应商, 模型）预先累加的汇总表，与明细同一个事务写入。用量页那三张图只按天、
 *   天 × 模型读合计，读的是「天数 × 模型数」那么几行，不必为一年窗口扫几十万行明细回表排序；
 *   WITHOUT ROWID 让主键即表，按天区间扫描直接是顺序 IO。
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
CREATE TABLE usage_messages (
  id INTEGER PRIMARY KEY,
  thread_id TEXT NOT NULL,
  day TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX usage_messages_by_day ON usage_messages (day);
CREATE TABLE usage_daily (
  day         TEXT NOT NULL,
  provider    TEXT NOT NULL,
  model       TEXT NOT NULL,
  input       INTEGER NOT NULL,
  output      INTEGER NOT NULL,
  cache_read  INTEGER NOT NULL,
  cache_write INTEGER NOT NULL,
  cost        REAL NOT NULL,
  PRIMARY KEY (day, provider, model)
) WITHOUT ROWID;`,
  },
]
