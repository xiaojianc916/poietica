import { describe, expect, test } from 'bun:test'
import {
  describeSchedule,
  formatGmtOffset,
  scheduleDayOfMonthOf,
  scheduleFor,
  scheduleKindOf,
  scheduleMinuteOf,
  scheduleTimeOf,
  scheduleWeekdaysOf,
  WEEKDAY_ORDER,
} from '../automation'

/* 调度栏的纯逻辑：cron 与人类可读摘要必须成对；界面上改任一格都要能由 cron 无损回显。 */

describe('schedule model', () => {
  test('每种常见频率都能从 cron 回显', () => {
    expect(scheduleKindOf('30 * * * *')).toBe('hourly')
    expect(scheduleMinuteOf('30 * * * *')).toBe(30)
    expect(scheduleKindOf('0 9 * * *')).toBe('daily')
    expect(scheduleTimeOf('0 9 * * 1-5')).toBe('09:00')
    expect(scheduleKindOf('5 18 * * 1,3,5')).toBe('weekly')
    expect(scheduleWeekdaysOf('5 18 * * 1,3,5')).toEqual([1, 3, 5])
    expect(scheduleKindOf('0 8 15 * *')).toBe('monthly')
    expect(scheduleDayOfMonthOf('0 8 15 * *')).toBe(15)
  })

  test('星期按周一到周日显示，不跟 cron 的数字顺序', () => {
    expect(scheduleFor('weekly', '09:00', [5, 1, 3])).toBe('0 9 * * 1,3,5')
    expect(describeSchedule('0 9 * * 1,3,5')).toBe('每周周一、周三、周五 09:00')
    expect(WEEKDAY_ORDER[0]).toBe(1)
  })

  test('每小时保留所选分钟，不再固定整点', () => {
    expect(scheduleFor('hourly', '09:30')).toBe('30 * * * *')
    expect(describeSchedule('30 * * * *')).toBe('每小时的第 30 分')
  })

  test('每月保留所选日期', () => {
    expect(scheduleFor('monthly', '08:15', [1], 15)).toBe('15 8 15 * *')
    expect(describeSchedule('0 9 15 * *')).toBe('每月 15 号 09:00')
  })

  test('不对已知频率之外的表达式装懂', () => {
    expect(scheduleKindOf('0 9 * * 1#2')).toBe('custom')
    expect(scheduleKindOf(null)).toBeNull()
  })

  test('GMT 偏移按半小时时区格式化', () => {
    expect(formatGmtOffset(480)).toBe('GMT+8')
    expect(formatGmtOffset(-210)).toBe('GMT-3:30')
    expect(formatGmtOffset(0)).toBe('GMT')
  })
})
