import { describe, expect, it } from 'bun:test'

import { describeSchedule, nextRunAfter, scheduleProblem } from './automation'

describe('scheduleProblem', () => {
  it('手动没有日程可查', () => {
    expect(scheduleProblem(null)).toBeNull()
  })

  it('常见的几段都通过', () => {
    expect(scheduleProblem('0 9 * * *')).toBeNull()
    expect(scheduleProblem('0 9 * * 1')).toBeNull()
    expect(scheduleProblem('0 9 1 * *')).toBeNull()
    expect(scheduleProblem('*/30 * * * *')).toBeNull()
  })

  it('读不懂的直说读不懂', () => {
    expect(scheduleProblem('每天九点')).toBe('unreadable')
    expect(scheduleProblem('* * *')).toBe('unreadable')
  })

  /* 心跳 30 秒，秒级表达式是一个兑现不了的承诺 —— 保存前就该被挡住。 */
  it('比心跳还密的落在 tooFrequent', () => {
    expect(scheduleProblem('* * * * * *')).toBe('tooFrequent')
  })
})

describe('nextRunAfter', () => {
  it('手动没有下一次', () => {
    expect(nextRunAfter(null, Date.now())).toBeNull()
  })

  /*
   * 本地构造：哪个时区跑，断言都成立。这一条盯的是「每天九点说的是本机的九点」，
   * 也就是求值时不传 timezone 这个决定。
   */
  it('落在本地墙钟的那个时刻', () => {
    const from = new Date(2026, 0, 1, 12, 0, 0).getTime()
    const next = new Date(nextRunAfter('0 9 * * *', from) as string)

    expect(next.getHours()).toBe(9)
    expect(next.getMinutes()).toBe(0)
    expect(next.getDate()).toBe(2)
  })

  it('关机错过的那些不逐次补，直接跨到之后的第一个', () => {
    const from = new Date(2026, 0, 4, 12, 0, 0).getTime()
    const next = new Date(nextRunAfter('0 9 * * *', from) as string)

    expect(next.getDate()).toBe(5)
    expect(next.getHours()).toBe(9)
  })

  it('每周一落在周一', () => {
    const from = new Date(2026, 0, 1, 12, 0, 0).getTime()
    const next = new Date(nextRunAfter('0 9 * * 1', from) as string)

    expect(next.getDay()).toBe(1)
    expect(next.getHours()).toBe(9)
  })

  /* 被外部改坏的目录文件只可能长这样：不排期，而不是每个心跳点一次火。 */
  it('读不懂的表达式不排期', () => {
    expect(nextRunAfter('每天九点', Date.now())).toBeNull()
  })
})

describe('describeSchedule', () => {
  it('手动是一句人话，定时是表达式原文', () => {
    expect(describeSchedule(null)).toBe('手动')
    expect(describeSchedule('0 9 * * *')).toBe('0 9 * * *')
  })
})
