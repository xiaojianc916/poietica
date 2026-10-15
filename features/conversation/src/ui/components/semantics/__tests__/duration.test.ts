import { describe, expect, test } from 'bun:test'
import { formatRunDuration, runDurationText } from '../duration'

/*
 * 运行状态行与封条的用时口径（DSH formatRunDuration）：
 * 整秒向下取整、六十秒起才带分、一小时起才带小时，秒永远在场。
 *
 * 拆成 parts 是为了让**只有数字**换等宽字（DSH 的 durationNumber）；下面钉的是口径本身，
 * 分格形状单独一组。
 */

describe('运行用时', () => {
  test('不足一秒与刚好一秒都报 1 秒：屏幕上不出现「0秒」', () => {
    expect(runDurationText(0)).toBe('0秒')
    expect(runDurationText(999)).toBe('0秒')
    expect(runDurationText(1_000)).toBe('1秒')
  })

  test('整秒向下取整：1.9 秒报 1 秒，不四舍五入', () => {
    expect(runDurationText(1_999)).toBe('1秒')
    expect(runDurationText(2_000)).toBe('2秒')
  })

  test('不到一分钟只报秒', () => {
    expect(runDurationText(4_000)).toBe('4秒')
    expect(runDurationText(59_999)).toBe('59秒')
  })

  test('一分钟起带分，秒照样在场（不是紧凑式）', () => {
    expect(runDurationText(60_000)).toBe('1分0秒')
    expect(runDurationText(90_000)).toBe('1分30秒')
    expect(runDurationText(3_599_000)).toBe('59分59秒')
  })

  test('一小时起带小时，分与秒照样在场', () => {
    expect(runDurationText(3_600_000)).toBe('1小时0分0秒')
    expect(runDurationText(3_661_000)).toBe('1小时1分1秒')
    expect(runDurationText(7_200_000)).toBe('2小时0分0秒')
  })

  test('负数与非法值当 0：宁可少报，也不要一个负的时长上屏', () => {
    expect(runDurationText(-1)).toBe('0秒')
    expect(runDurationText(Number.NaN)).toBe('0秒')
  })
})

describe('数字与单位分格（等宽字只戴在数字上）', () => {
  test('4 秒：数字一格、单位一格', () => {
    expect(formatRunDuration(4_000)).toEqual([
      { numeric: true, text: '4' },
      { numeric: false, text: '秒' },
    ])
  })

  test('1 分 26 秒：数字与单位交替，汉字不戴等宽', () => {
    expect(formatRunDuration(86_000)).toEqual([
      { numeric: true, text: '1' },
      { numeric: false, text: '分' },
      { numeric: true, text: '26' },
      { numeric: false, text: '秒' },
    ])
  })

  test('1 小时：三对数字与单位', () => {
    expect(formatRunDuration(3_661_000).map((part) => part.text)).toEqual(['1', '小时', '1', '分', '1', '秒'])
  })

  test('拼回去与逐格渲染等价：两条渲染路径不会各说各的', () => {
    for (const span of [0, 999, 1_000, 59_999, 60_000, 3_661_000, 7_200_000]) {
      expect(
        formatRunDuration(span)
          .map((part) => part.text)
          .join(''),
      ).toBe(runDurationText(span))
    }
  })
})
