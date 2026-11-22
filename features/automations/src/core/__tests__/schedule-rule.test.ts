import { describe, expect, test } from 'bun:test'
import type { ScheduleRule } from '../../contract/entities'
import { compatCronOf, computeRuleNext, defaultFields, parseCompatFields, ruleFromInterval } from '../schedule-rule'

/* 规则算法只认任务时区的墙钟：分钟/小时是固定时长，日/周/月/年走日历。用例固定 UTC 或 Asia/Shanghai 的整数偏移，
 * 另有一条 America/New_York 的 DST 用例钉住「09:00 还是 09:00，UTC 偏移会变」。 */

const SH = 'Asia/Shanghai'

function rule(over: Partial<ScheduleRule> & Pick<ScheduleRule, 'unit' | 'anchorAt'>): ScheduleRule {
  return { interval: 1, hour: 9, minute: 0, ...over }
}

describe('schedule rule', () => {
  test('分钟间隔从锚点起算，晚派发不累积漂移', () => {
    const anchorAt = Date.UTC(2026, 0, 1, 0, 0, 30)
    const every90 = rule({ unit: 'minute', interval: 90, anchorAt })
    expect(computeRuleNext(every90, 'UTC', anchorAt)).toBe(anchorAt + 90 * 60_000)
    /* 晚 90 分钟才问下一次：仍是锚点 + 180 分钟，不是「上次 + 90」。 */
    expect(computeRuleNext(every90, 'UTC', anchorAt + 90 * 60_000)).toBe(anchorAt + 180 * 60_000)
  })

  test('每日按任务时区的墙钟 09:00，不是 UTC 09:00', () => {
    const anchorAt = Date.UTC(2026, 0, 1, 1, 0) // 上海 09:00
    const daily = rule({ unit: 'daily', anchorAt })
    expect(computeRuleNext(daily, SH, anchorAt)).toBe(Date.UTC(2026, 0, 2, 1, 0))
  })

  test('每周按锚点所在的周一起算，间隔 2 周就只落在隔周', () => {
    const anchorAt = Date.UTC(2026, 0, 7, 2, 0) // 上海 1 月 7 日周三 10:00
    const biweeklyMonday = rule({ unit: 'weekly', interval: 2, anchorAt, weekdays: [1] })
    expect(computeRuleNext(biweeklyMonday, SH, anchorAt)).toBe(Date.UTC(2026, 0, 19, 1, 0))
  })

  test('每月 31 日：当月没有这一天就跳过去，不滚到别的日期', () => {
    const anchorAt = Date.UTC(2026, 0, 1, 1, 0)
    const monthly = rule({ unit: 'monthly', anchorAt, monthDays: [31] })
    expect(computeRuleNext(monthly, SH, Date.UTC(2026, 1, 1, 0, 0))).toBe(Date.UTC(2026, 2, 31, 1, 0))
  })

  test('每年 2 月 29 日：非闰年整年跳过', () => {
    const anchorAt = Date.UTC(2024, 1, 29, 1, 0)
    const yearly = rule({ unit: 'yearly', anchorAt, months: [2], monthDays: [29] })
    expect(computeRuleNext(yearly, SH, Date.UTC(2025, 2, 1))).toBe(Date.UTC(2028, 1, 29, 1, 0))
  })

  test('DST 跳变后仍是墙钟 09:00：纽约 3 月 8 日对应 13:00Z，而 3 月 7 日是 14:00Z', () => {
    const anchorAt = Date.UTC(2026, 0, 1, 14, 0) // 纽约 09:00 EST
    const daily = rule({ unit: 'daily', anchorAt })
    expect(computeRuleNext(daily, 'America/New_York', Date.UTC(2026, 2, 7, 15, 0))).toBe(Date.UTC(2026, 2, 8, 13, 0))
  })

  test('carrier 归一化：兼容 cron 决定时分与星期，真实间隔由 interval 决定', () => {
    const anchorAt = Date.UTC(2026, 0, 5, 1, 30) // 上海周一 09:30
    const fields = parseCompatFields('30 9 * * 1,3,5', anchorAt, SH)
    expect(fields).toEqual({ minute: 30, hour: 9, weekdays: [1, 3, 5], monthDays: undefined, months: undefined })
    const weekly = ruleFromInterval('weekly', 2, fields, anchorAt)
    expect(compatCronOf(weekly)).toBe('30 9 * * 1,3,5')
    expect(computeRuleNext(weekly, SH, anchorAt)).toBe(Date.UTC(2026, 0, 7, 1, 30))
  })

  test('carrier 没给 cron 时回退锚点墙钟；超上限的间隔仍给一条合法展示 cron', () => {
    const anchorAt = Date.UTC(2026, 0, 5, 1, 30)
    expect(defaultFields(anchorAt, SH)).toEqual({
      hour: 9,
      minute: 30,
      weekdays: [1],
      monthDays: [5],
      months: [1],
    })
    expect(compatCronOf(rule({ unit: 'minute', interval: 90, anchorAt }))).toBe('0 * * * *')
    expect(compatCronOf(rule({ unit: 'hourly', interval: 50, anchorAt }))).toBe('0 0 * * *')
  })
})
