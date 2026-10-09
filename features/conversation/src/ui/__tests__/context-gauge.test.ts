import { describe, expect, test } from 'bun:test'
import type { AgentUsageBreakdown } from '../agent/dto'
import type { SessionUsage } from '../agent/usage'
import { formatTokens, gaugeLayout } from '../components/composer/context-gauge'

/*
 * 面板上的数与段只有这一处算法。正本（DSH 的 ContextMeter）把读数与分段分开算，
 * 这里合成一次，于是判据能落在纯函数上 —— 不断言 DOM。
 *
 * 夹具守 omp 自己的恒等式：五类占用之和就是 used，再加空闲与自动压缩缓冲正好是整个
 * 窗口（它的 getContextBreakdown 与 computeContextBreakdown 就是这么算的）。编一组
 * 对不上的数，测的就不是这条恒等式了。
 */
const breakdown = (overrides: Partial<AgentUsageBreakdown>): AgentUsageBreakdown => ({
  systemPrompt: 3_000,
  systemContext: 500,
  systemTools: 16_000,
  skills: 2_500,
  messages: 118_000,
  free: 30_000,
  autoCompactBuffer: 30_000,
  ...overrides,
})

const usage = (parts: AgentUsageBreakdown | null): SessionUsage => ({
  used: 140_000,
  size: 200_000,
  inputOther: 1,
  inputCacheRead: 2,
  inputCacheCreation: 3,
  breakdown: parts,
})

describe('上下文面板的读数与分段', () => {
  test('紧凑计数与正本同一条阶梯', () => {
    expect(formatTokens(0)).toBe('0')
    expect(formatTokens(999)).toBe('999')
    expect(formatTokens(1_000)).toBe('1K')
    expect(formatTokens(2_000)).toBe('2K')
    expect(formatTokens(151_000)).toBe('151K')
    expect(formatTokens(999_999)).toBe('1000K')
    expect(formatTokens(1_000_000)).toBe('1M')
    expect(formatTokens(1_500_000)).toBe('1.5M')
  })

  /*
   * 条只铺已用的那几类：段的宽度 = 读数 × 该类占已用之和的比例，合计正好等于读数。
   * 「空闲」与「自动压缩缓冲」就是条上剩下的那段灰，不另占一段。
   */
  test('条上的段只含已用的那几类，合计等于读数', () => {
    const layout = gaugeLayout(usage(breakdown({})))

    expect(layout.reading).toBe('70%')
    expect(layout.used).toBe(140_000)
    expect(layout.segments.map((segment) => segment.key)).toEqual([
      'systemPrompt',
      'systemTools',
      'systemContext',
      'skills',
      'messages',
    ])

    const width = layout.segments.reduce((sum, segment) => sum + segment.width, 0)
    expect(width).toBeCloseTo(70, 5)
  })

  test('某几格为零时不画零宽段', () => {
    const layout = gaugeLayout(usage(breakdown({ skills: 0 })))

    expect(layout.segments.map((segment) => segment.key)).not.toContain('skills')
  })

  /* 正本那张 2% 的图：一条几乎空的条，靠灰底显示余量. */
  test('读数很小时条只有一小点，不铺满', () => {
    const layout = gaugeLayout({ ...usage(breakdown({})), used: 4_000, size: 200_000 })

    expect(layout.reading).toBe('2%')
    const width = layout.segments.reduce((sum, segment) => sum + segment.width, 0)
    expect(width).toBeCloseTo(2, 5)
  })

  /* 线上那一格是 | null，渲染处只挡一种缺席写法 —— 这里钉住收敛后的那一种。 */
  test('构成缺席时只有一条总条，也不画行', () => {
    const layout = gaugeLayout(usage(null))

    expect(layout.breakdown).toBeUndefined()
    expect(layout.segments).toEqual([{ key: 'total', width: 70 }])
  })

  test('读完超窗时读数封顶，不画出超过 100 的条', () => {
    const layout = gaugeLayout({ ...usage(null), used: 3_000_000 })

    expect(layout.reading).toBe('100%')
    expect(layout.segments).toEqual([{ key: 'total', width: 100 }])
  })
})
