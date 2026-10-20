import { describe, expect, test } from 'bun:test'
import { cacheHitRate, formatTokens, gaugeLayout } from '../composer/view/context-gauge'
import type { AgentSessionTokens, AgentUsageBreakdown } from '../shared/model/dto'
import type { SessionUsage } from '../shared/model/usage'

/*
 * 夹具守 omp 自己的恒等式：五类占用之和就是 used，编一组对不上的数就测不到这条恒等式。
 */
const breakdown = (overrides: Partial<AgentUsageBreakdown>): AgentUsageBreakdown => ({
  systemPrompt: 3_000,
  systemContext: 500,
  systemTools: 16_000,
  skills: 2_500,
  messages: 118_000,
  ...overrides,
})

const usage = (parts: AgentUsageBreakdown | null, tokens: AgentSessionTokens | null = null): SessionUsage => ({
  used: 140_000,
  size: 200_000,
  breakdown: parts,
  tokens,
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

  /* 段宽 = 读数 × 该类占已用之和的比例；没用上的空间是条上剩下的那段灰，不另占一段。 */
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

  test('读数很小时条只有一小点，不铺满', () => {
    const layout = gaugeLayout({ ...usage(breakdown({})), used: 4_000, size: 200_000 })

    expect(layout.reading).toBe('2%')
    const width = layout.segments.reduce((sum, segment) => sum + segment.width, 0)
    expect(width).toBeCloseTo(2, 5)
  })

  /* 线上那一格是 | null，渲染处只挡一种缺席写法，这里钉住收敛后的那一种。 */
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

  /* 命中率的分母是 omp 的提示词口径：未命中输入 + 缓存读 + 缓存写。output 不进分母。 */
  test('缓存命中率 = cacheRead ÷ (input + cacheRead + cacheWrite)', () => {
    expect(cacheHitRate({ input: 10, output: 999, cacheRead: 80, cacheWrite: 10, total: 1_099 })).toBeCloseTo(0.8, 10)
    expect(cacheHitRate({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 })).toBeNull()
  })

  test('会话用量两行：命中率按百分比、消耗按短写；新会话没有输入时命中率画「—」', () => {
    const tokens: AgentSessionTokens = {
      input: 12_000,
      output: 3_000,
      cacheRead: 84_000,
      cacheWrite: 4_000,
      total: 103_000,
    }
    expect(gaugeLayout(usage(breakdown({}), tokens)).session).toEqual({ cacheHitRate: '84%', tokensSpent: '~103K' })

    const fresh: AgentSessionTokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
    expect(gaugeLayout(usage(breakdown({}), fresh)).session).toEqual({ cacheHitRate: '—', tokensSpent: '~0' })
  })

  test('会话用量缺席：两行都不画；构成缺席不连累会话用量', () => {
    expect(gaugeLayout(usage(breakdown({}))).session).toBeUndefined()
    const tokens: AgentSessionTokens = { input: 1, output: 1, cacheRead: 1, cacheWrite: 0, total: 3 }
    expect(gaugeLayout(usage(null, tokens)).session).toEqual({ cacheHitRate: '50%', tokensSpent: '~3' })
  })
})
