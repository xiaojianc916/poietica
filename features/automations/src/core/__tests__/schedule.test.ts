import { describe, expect, test } from 'bun:test'
import { nextAfter, preview } from '../schedule'

const millis = (iso: string): number => Date.parse(iso)

describe('schedule（legacy crates/automation/src/schedule.rs 全部用例）', () => {
  test('最小粒度检查的是秒字段能命中的全部值，不是两个未来样本', () => {
    expect(preview('0,30 0 0 1 1 *', 'UTC', 0, 5).problem).toBe('too_frequent')
    expect(preview('59 * * * * *', 'UTC', 0, 5).problem).toBeNull()
    expect(preview('0/10 * * * *', 'UTC', 0, 5).problem).toBeNull()
  })

  test('显式时区与错过的时刻', () => {
    const now = millis('2026-01-04T10:00:00+08:00')
    expect(nextAfter('0 9 * * *', 'Asia/Shanghai', now).next).toBe(millis('2026-01-05T01:00:00.000Z'))
    expect(preview('0 0 31 2 *', 'UTC', now, 5).problem).toBe('never_runs')
    expect(preview(null, 'not/a-zone', now, 5).problem).toBe('time_zone')
  })

  test('夏令时固定时刻只跑一次，跳过的时刻用第一个真实瞬间', () => {
    const before = millis('2025-10-26T00:00:00Z')
    const first = nextAfter('30 2 * * *', 'Europe/Stockholm', before).next
    /*
     * 秋季回拨那一夜当地 02:30 出现两次（CEST 与 CET）。croner 9.1.0 取第二次（01:30Z），
     * croner 10.0.1 改成第一次（00:30Z）——与 legacy 的 Rust croner 逐字一致，
     * 于是这条从「遗留偏差」变回「与 legacy 相同」。语义仍是「只跑一次」，次日落在 01:30Z。
     */
    expect(first).toBe(millis('2025-10-26T00:30:00.000Z'))
    expect(nextAfter('30 2 * * *', 'Europe/Stockholm', first!).next).toBe(millis('2025-10-27T01:30:00.000Z'))
    /*
     * 春季跳变那一夜当地 02:30 不存在。legacy 的 Rust croner 取「第一个真实瞬间」
     * 03:00 当地（01:00Z）；JS croner v9.1.0 保留分钟个位，取 03:30 当地（01:30Z）。
     * 两者都是「这一天仍然运行一次」，差异只在落点（见进度报告「遗留偏差」）。
     */
    expect(nextAfter('30 2 * * *', 'Europe/Stockholm', millis('2025-03-30T00:59:59Z')).next).toBe(
      millis('2025-03-30T01:30:00.000Z'),
    )
  })

  test('每秒的表达式读作 too_frequent', () => {
    expect(preview('* * * * * *', 'UTC', 0, 5).problem).toBe('too_frequent')
  })

  test('跨夏令时切换日：America/New_York 的 02:30 平移进存在的当地时刻', () => {
    /*
     * 2026-03-08 当地 02:30 不存在（跳到 03:00）。JS croner v9.1.0 把这次跳过的
     * 时刻平移到当天 03:30 EDT（07:30Z），仍是一次有效运行；次日 03-09 回到当地 02:30。
     * legacy 的 Rust croner 会顺延到 03-09 的 02:30——同一「不丢一次」语义的不同落点。
     */
    const before = millis('2026-03-08T00:00:00-05:00')
    expect(nextAfter('30 2 * * *', 'America/New_York', before).next).toBe(millis('2026-03-08T07:30:00.000Z'))
  })

  test('cron 为 null 是只手动运行：没有下一次也没有问题', () => {
    expect(nextAfter(null, 'Asia/Shanghai', 0)).toEqual({ next: null, problem: null })
  })

  test('读不懂的表达式', () => {
    expect(preview('0 0 * *', 'UTC', 0, 5).problem).toBe('unreadable')
    expect(preview('0 0 * * ?', 'UTC', 0, 5).problem).toBe('unreadable')
  })
})
