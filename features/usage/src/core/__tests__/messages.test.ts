import { describe, expect, test } from 'bun:test'
import { openDatabase } from '@poietica/storage-sqlite'
import { migrations } from '../migrations'
import { createUsageRepo } from '../repo'

/* 口径是**用户发出去的句子数**（含插话），不是模型采样条数。原方案给的实现是数 usage_events 的行（一次模型调用 = 一条消息），而 legacy
 * 与 ADR 0039 的口径是准入账（turn_admissions）—— 两者相差一个数量级（一次用户输入会引出多次模型调用）。2026-10-07 按产品负责人裁决
 * 改回 legacy 口径，这条钉住它。 */
function makeRepo() {
  const db = openDatabase(':memory:')
  for (const m of migrations) db.forModule('usage').exec(m.sql!)
  return { db, repo: createUsageRepo(db.forModule('usage')) }
}

function sample(day: string) {
  return {
    threadId: 't1',
    day,
    at: 0,
    provider: 'p',
    model: 'm',
    input: 1,
    output: 1,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
  }
}

describe('消息数量数的是准入账，不是采样条数', () => {
  test('一天里 5 次采样但用户只说了 1 句 → 消息数 1', () => {
    const { db, repo } = makeRepo()

    for (let i = 0; i < 5; i += 1) {
      repo.insert(sample('2026-10-07'))
    }
    repo.insertMessage({ threadId: 't1', at: new Date(2026, 9, 7, 10, 0).getTime() })

    expect(repo.messageCount('2026-10-07', '2026-10-07')).toEqual([{ day: '2026-10-07', count: 1 }])
    db.close()
  })

  test('没有采样也可以有消息（只说了一句、模型还没回）', () => {
    const { db, repo } = makeRepo()
    repo.insertMessage({ threadId: 't1', at: new Date(2026, 9, 7, 9, 0).getTime() })

    expect(repo.messageCount('2026-10-07', '2026-10-07')).toEqual([{ day: '2026-10-07', count: 1 }])
    expect(repo.tokenDays('2026-10-07', '2026-10-07')).toEqual([])
    db.close()
  })

  test('按天分组、由早到晚，插话也算一句', () => {
    const { db, repo } = makeRepo()
    const at = (day: number, hour: number) => new Date(2026, 9, day, hour, 0).getTime()

    repo.insertMessage({ threadId: 't1', at: at(7, 9) })
    repo.insertMessage({ threadId: 't1', at: at(7, 9) }) // 同一轮里的插话
    repo.insertMessage({ threadId: 't2', at: at(5, 20) })

    expect(repo.messageCount('2026-10-05', '2026-10-07')).toEqual([
      { day: '2026-10-05', count: 1 },
      { day: '2026-10-07', count: 2 },
    ])
    db.close()
  })

  test('窗口外的消息不算（区间是闭区间，两端都算）', () => {
    const { db, repo } = makeRepo()
    repo.insertMessage({ threadId: 't1', at: new Date(2026, 9, 1, 0, 0).getTime() })
    repo.insertMessage({ threadId: 't1', at: new Date(2026, 9, 7, 23, 0).getTime() })

    expect(repo.messageCount('2026-10-01', '2026-10-07').map((d) => d.count)).toEqual([1, 1])
    expect(repo.messageCount('2026-10-02', '2026-10-06')).toEqual([])
    db.close()
  })

  test('本地日界：23:59 与次日 00:00 落在两天', () => {
    const { db, repo } = makeRepo()
    repo.insertMessage({ threadId: 't1', at: new Date(2026, 9, 7, 23, 59, 59).getTime() })
    repo.insertMessage({ threadId: 't1', at: new Date(2026, 9, 8, 0, 0, 1).getTime() })

    expect(repo.messageCount('2026-10-07', '2026-10-08')).toEqual([
      { day: '2026-10-07', count: 1 },
      { day: '2026-10-08', count: 1 },
    ])
    db.close()
  })
})

describe('v2 迁移', () => {
  test('迁移表是 v1 + v2 + v3，且 v2 建的是准入账', () => {
    expect(migrations.map((m) => m.version)).toEqual([1, 2, 3])
    expect(migrations[1]?.sql).toContain('usage_messages')
  })

  /* v2 是**叠加**在 v1 之上：两张表都要能用。不去查 sqlite_master —— storage 的 SQL 守卫只放行本模块前缀的表，所以两边各写一行、各读一遍。 */
  test('两张表都能写能读（v2 不改 v1）', () => {
    const { db, repo } = makeRepo()

    repo.insert(sample('2026-10-07'))
    repo.insertMessage({ threadId: 't1', at: new Date(2026, 9, 7, 12, 0).getTime() })

    expect(repo.tokenDays('2026-10-07', '2026-10-07')).toHaveLength(1)
    expect(repo.messageCount('2026-10-07', '2026-10-07')).toEqual([{ day: '2026-10-07', count: 1 }])
    db.close()
  })
})
