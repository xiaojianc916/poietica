import type { Migration } from '@poietica/storage-sqlite'

/* v2 是 2026-10-07 的修正：原方案给的 messageCount 口径是「一次模型调用 = 一条消息」（数 usage_events 的行），而 legacy 与 ADR 0039
 * 的口径是**用户发出去的句子数** —— 两者相差一个数量级（一次用户输入会引出多次模型调用），屏幕上的数字对不上。按产品负责人裁决改回
 * legacy 口径：另立一张按天的准入账，不去猜哪些采样属于同一次输入。 */
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
CREATE INDEX usage_events_by_day ON usage_events (day);
CREATE INDEX usage_events_by_thread ON usage_events (thread_id);`,
  },
  {
    version: 2,
    name: 'messages',
    sql: `CREATE TABLE usage_messages (
  id INTEGER PRIMARY KEY,
  thread_id TEXT NOT NULL,
  day TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX usage_messages_by_day ON usage_messages (day);`,
  },
  {
    version: 3,
    name: 'daily_rollup',
    /*
     * 按天汇总表（数据库性能方案 D1）：用量页那三张图只按「天 / 天 × 模型」读合计，原先每次都从 usage_events 现算 ——
     * 一次模型调用一行、只增不减，窗口一长（热力图读一整年）就是几十万行回表加临时排序，实测 30 万行一年窗口要 0.4～0.7 秒。
     * 改成落账时顺手累加进这张表（与明细同一个事务），读的是「天数 × 模型数」那么几行。
     *
     * usage_events 照旧逐条记，是这张表的原始账（要重算时从它 GROUP BY 一遍，正是下面的回填）；它的两个索引没有任何查询再用
     * （by_thread 从来没人按线程查过），每条采样白白多写两棵 B 树，一并删掉。
     */
    sql: `CREATE TABLE usage_daily (
  day         TEXT NOT NULL,
  provider    TEXT NOT NULL,
  model       TEXT NOT NULL,
  input       INTEGER NOT NULL,
  output      INTEGER NOT NULL,
  cache_read  INTEGER NOT NULL,
  cache_write INTEGER NOT NULL,
  cost        REAL NOT NULL,
  PRIMARY KEY (day, provider, model)
) WITHOUT ROWID;
INSERT INTO usage_daily (day, provider, model, input, output, cache_read, cache_write, cost)
  SELECT day, provider, model, SUM(input), SUM(output), SUM(cache_read), SUM(cache_write), SUM(cost)
    FROM usage_events GROUP BY day, provider, model;
DROP INDEX usage_events_by_day;
DROP INDEX usage_events_by_thread;`,
  },
]
