import { describe, expect, test } from 'bun:test'
import { formatRunDuration } from '../duration'

/*
 * 运行状态行与封条的用时口径（DSH formatRunDuration）：
 * 整秒向下取整、六十秒起才带分、一小时起才带小时，秒永远在场。
 */

describe('运行用时', () => {
  test('不足一秒与刚好一秒都报 1 秒：屏幕上不出现「0秒」', () => {
    expect(formatRunDuration(0)).toBe('0秒')
    expect(formatRunDuration(999)).toBe('0秒')
    expect(formatRunDuration(1_000)).toBe('1秒')
  })

  test('整秒向下取整：1.9 秒报 1 秒，不四舍五入', () => {
    expect(formatRunDuration(1_999)).toBe('1秒')
    expect(formatRunDuration(2_000)).toBe('2秒')
  })

  test('不到一分钟只报秒', () => {
    expect(formatRunDuration(4_000)).toBe('4秒')
    expect(formatRunDuration(59_999)).toBe('59秒')
  })

  test('一分钟起带分，秒照样在场（不是紧凑式）', () => {
    expect(formatRunDuration(60_000)).toBe('1分0秒')
    expect(formatRunDuration(90_000)).toBe('1分30秒')
    expect(formatRunDuration(3_599_000)).toBe('59分59秒')
  })

  test('一小时起带小时，分与秒照样在场', () => {
    expect(formatRunDuration(3_600_000)).toBe('1小时0分0秒')
    expect(formatRunDuration(3_661_000)).toBe('1小时1分1秒')
    expect(formatRunDuration(7_200_000)).toBe('2小时0分0秒')
  })

  test('负数与非法值当 0：宁可少报，也不要一个负的时长上屏', () => {
    expect(formatRunDuration(-1)).toBe('0秒')
    expect(formatRunDuration(Number.NaN)).toBe('0秒')
  })
})
