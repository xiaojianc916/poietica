import { describe, expect, it } from 'bun:test'
import { dayKeyOf, spread, summarize } from '../usage-activity'

describe('US-1: 插入跨 3 天、2 个模型的采样', () => {
  it('tokenDays 3 行', () => {
    const days = spread(
      new Map([
        ['2026-10-01', 100],
        ['2026-10-02', 200],
        ['2026-10-03', 300],
      ]),
      new Date('2026-10-03'),
      3,
    )
    expect(days.length).toBe(3)
    expect(days[0]?.count).toBe(100)
    expect(days[2]?.count).toBe(300)
  })
})

describe('US-2: 本地时间 23:59:59 与次日 00:00:01 的两条采样', () => {
  it('落在两天', () => {
    const key1 = dayKeyOf(new Date(2026, 9, 3, 23, 59, 59))
    const key2 = dayKeyOf(new Date(2026, 9, 4, 0, 0, 1))
    expect(key1).toBe('2026-10-03')
    expect(key2).toBe('2026-10-04')
  })
})

describe('summarize', () => {
  it('概览：3 天 2 次对话', () => {
    const result = summarize(['2026-10-01T10:00:00', '2026-10-03T14:00:00'], new Date('2026-10-03'), 3)
    expect(result.threads).toBe(2)
    expect(result.activeDays).toBe(2)
  })
})
