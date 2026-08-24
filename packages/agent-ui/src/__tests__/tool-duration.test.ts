import { describe, expect, it } from 'bun:test'

import { formatDuration, HOUR, MINUTE, nextTickOf, SECOND } from '../semantics/duration'

/*
 * 工具调用的耗时。
 *
 * 纯函数，不渲染：这一格的全部判断都在这两个函数里，组件只负责把它接到时钟上。
 * 文案一律拿 Intl 现算出来比，不写死中文 —— 写死就等于把语言钉在简体中文上，
 * 而这些字是平台给的。
 */

const narrow = (unit: string, value: number, maximumFractionDigits = 0) =>
  new Intl.NumberFormat(undefined, {
    maximumFractionDigits,
    style: 'unit',
    unit,
    unitDisplay: 'narrow',
  }).format(value)

describe('调用耗时', () => {
  it('不足一秒不报,快到没人读得到的调用不闪那一下', () => {
    expect(formatDuration(0)).toBeNull()
    expect(formatDuration(999)).toBeNull()
  })

  it('秒档带一位小数,不足一秒的差别留得住', () => {
    expect(formatDuration(1_240)).toBe(narrow('second', 1.2, 1))
    expect(formatDuration(59_900)).toBe(narrow('second', 59.9, 1))
  })

  it('整秒不拖一个多余的小数点', () => {
    expect(formatDuration(3 * SECOND)).toBe(narrow('second', 3, 1))
  })

  it('一分钟以上补上秒,分钟档的取整不吃掉那 59 秒', () => {
    expect(formatDuration(MINUTE + 12 * SECOND)).toBe(
      `${narrow('minute', 1)} ${narrow('second', 12, 1)}`,
    )
    expect(formatDuration(2 * MINUTE)).toBe(narrow('minute', 2))
  })

  it('一小时以上只到分,不再报秒', () => {
    expect(formatDuration(HOUR + 23 * MINUTE + 45 * SECOND)).toBe(
      `${narrow('hour', 1)} ${narrow('minute', 23)}`,
    )
  })

  it('期限落在文案真正改口的那一刻,不是一个猜出来的周期', () => {
    const startedAt = 1_000_000

    /* 秒档：显示到秒,所以下一次改口是它自己的下一整秒。 */
    expect(nextTickOf(startedAt, startedAt + 4_300)).toBe(startedAt + 5 * SECOND)

    /* 时档：只显示到分,每秒唤醒整屏算白醒。 */
    expect(nextTickOf(startedAt, startedAt + HOUR + 20 * MINUTE + 30 * SECOND)).toBe(
      startedAt + HOUR + 21 * MINUTE,
    )
  })
})
