import { describe, expect, it } from 'vitest'
import {
  busiestOf,
  dayKeyOf,
  levelOf,
  shiftDays,
  spread,
  summarize,
  weekdayOf,
} from '../usage/usage-activity'

/*
 * 全部用本地时刻构造，所以在任何时区下结论相同：日历索引读的就是本地日历字段。
 */

describe('用量统计', () => {
  it('概览把每条对话记在它最后活动的那一天', () => {
    const now = new Date(2026, 7, 11)

    const times = [
      new Date(2026, 7, 11, 9).toISOString(),
      new Date(2026, 7, 11, 21).toISOString(),
      new Date(2026, 7, 9, 13).toISOString(),
    ]

    const overview = summarize(times, now, 7)

    expect(overview.threads).toBe(3)
    expect(overview.activeDays).toBe(2)
  })

  it('窗口之外的对话不进概览', () => {
    const now = new Date(2026, 7, 11)
    const times = [new Date(2026, 6, 20, 9).toISOString()]

    expect(summarize(times, now, 7).threads).toBe(0)
    expect(summarize(times, now, 30).threads).toBe(1)
  })

  it('今天还没有活动时，连续天数从昨天起算', () => {
    const now = new Date(2026, 7, 11)
    const times = [new Date(2026, 7, 10, 8).toISOString(), new Date(2026, 7, 9, 8).toISOString()]

    expect(summarize(times, now, 30).streak).toBe(2)
  })

  it('空账也铺满整段日历，且全是最低档', () => {
    const days = spread(new Map(), new Date(2026, 7, 11), 182)

    expect(days).toHaveLength(182)
    expect(busiestOf(days)).toBe(0)
    expect(days.at(-1)).toEqual({ date: '2026-08-11', count: 0 })
  })

  it('有账的日子按账走', () => {
    const ledger = new Map([['2026-08-10', 12_000]])
    const days = spread(ledger, new Date(2026, 7, 11), 2)

    expect(days).toEqual([
      { date: '2026-08-10', count: 12_000 },
      { date: '2026-08-11', count: 0 },
    ])
  })

  it('跨月回退不会错开一天', () => {
    expect(dayKeyOf(shiftDays(new Date(2026, 7, 1), -1))).toBe('2026-07-31')
  })

  it('日期键按本地零点读回，周一记 0', () => {
    expect(weekdayOf('2026-08-11')).toBe(1)
  })

  it('没有活动的一天不占档位', () => {
    expect(levelOf(0, 4)).toBe(0)
    expect(levelOf(1, 4)).toBe(1)
    expect(levelOf(4, 4)).toBe(4)
  })
})
