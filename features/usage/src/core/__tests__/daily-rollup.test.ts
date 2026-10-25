import { describe, expect, test } from 'bun:test'
import { openDatabase } from '@poietica/storage-sqlite'
import { migrations } from '../migrations'
import { createUsageRepo } from '../repo'

/* 按天汇总表（数据库性能方案 D1）：读的一侧只碰 usage_daily；它必须与「从 usage_events 现算」逐格相同。 */
type Sample = Parameters<ReturnType<typeof createUsageRepo>['insert']>[0]

function sample(day: string, provider: string, model: string, n: number): Sample {
  return {
    threadId: `t${n % 3}`,
    day,
    at: n,
    provider,
    model,
    input: 10 * n,
    output: n,
    cacheRead: 2 * n,
    cacheWrite: 3 * n,
    cost: 0,
  }
}

function fresh() {
  const db = openDatabase(':memory:')
  const mdb = db.forModule('usage')
  for (const m of migrations) mdb.exec(m.sql)
  return { db, mdb, repo: createUsageRepo(mdb) }
}

/** 对照：直接从明细 GROUP BY（每一格的真值，汇总表必须与它逐格相同） */
function fromEvents(mdb: ReturnType<typeof fresh>['mdb'], from: string, to: string) {
  return {
    days: mdb
      .prepare(
        `SELECT day, SUM(input) AS input, SUM(output) AS output, SUM(cache_read) AS cacheRead,
                SUM(cache_write) AS cacheWrite, SUM(cost) AS cost
           FROM usage_events WHERE day BETWEEN ? AND ? GROUP BY day ORDER BY day`,
      )
      .all(from, to),
    models: mdb
      .prepare(
        `SELECT day, provider, model, SUM(input) AS input, SUM(output) AS output, SUM(cost) AS cost
           FROM usage_events WHERE day BETWEEN ? AND ? GROUP BY day, provider, model ORDER BY day, provider, model`,
      )
      .all(from, to),
  }
}

const SAMPLES: Sample[] = [
  sample('2026-10-01', 'anthropic', 'opus', 1),
  sample('2026-10-01', 'anthropic', 'opus', 2),
  sample('2026-10-01', 'openai', 'gpt', 3),
  sample('2026-10-02', 'anthropic', 'sonnet', 4),
  sample('2026-10-03', 'anthropic', 'opus', 5),
  sample('2026-10-03', 'anthropic', 'opus', 6),
  sample('2026-10-03', 'openai', 'gpt', 7),
]

describe('usage_daily：落账时累加', () => {
  test('同一天同一模型多次采样累加成一行；与从明细现算逐格相同', () => {
    const { db, mdb, repo } = fresh()
    for (const s of SAMPLES) repo.insert(s)

    expect(repo.tokenDays('2026-10-01', '2026-10-03')).toEqual(
      fromEvents(mdb, '2026-10-01', '2026-10-03').days as never,
    )
    expect(repo.modelDays('2026-10-01', '2026-10-03')).toEqual(
      fromEvents(mdb, '2026-10-01', '2026-10-03').models as never,
    )
    expect(repo.modelDays('2026-10-01', '2026-10-01')).toEqual([
      { day: '2026-10-01', provider: 'anthropic', model: 'opus', input: 30, output: 3, cost: 0 },
      { day: '2026-10-01', provider: 'openai', model: 'gpt', input: 30, output: 3, cost: 0 },
    ])
    /* 明细照旧逐条记 */
    expect(mdb.prepare<{ n: number }>('SELECT COUNT(*) AS n FROM usage_events').get()).toEqual({ n: SAMPLES.length })
    db.close()
  })

  test('窗口是闭区间，窗口外的天不读', () => {
    const { db, repo } = fresh()
    for (const s of SAMPLES) repo.insert(s)
    expect(repo.tokenDays('2026-10-02', '2026-10-02').map((d) => d.day)).toEqual(['2026-10-02'])
    expect(repo.modelDays('2026-10-04', '2026-10-09')).toEqual([])
    db.close()
  })
})

describe('汇总表的查询计划', () => {
  test('读汇总表不回表、不排序（计划里没有临时 B 树）', () => {
    const { db } = fresh()
    const plan = (sql: string) =>
      (db.raw.query(`EXPLAIN QUERY PLAN ${sql}`).all('2026-10-01', '2026-10-03') as Array<{ detail: string }>).map(
        (r) => r.detail,
      )
    const token = plan('SELECT day, SUM(input) FROM usage_daily WHERE day BETWEEN ? AND ? GROUP BY day ORDER BY day')
    const model = plan(
      'SELECT day, provider, model, input FROM usage_daily WHERE day BETWEEN ? AND ? ORDER BY day, provider, model',
    )
    for (const detail of [...token, ...model]) expect(detail).not.toContain('TEMP B-TREE')
    expect(token.join(' ')).toContain('PRIMARY KEY')
    db.close()
  })
})
