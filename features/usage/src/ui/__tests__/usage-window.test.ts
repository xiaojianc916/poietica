import { describe, expect, test } from 'bun:test'
import { windowOf } from '../api'
import { labelModels } from '../model-labels'

describe('窗口：最近 span 天，含今天', () => {
  const now = new Date(2026, 9, 7, 15, 30) // 2026-10-07 本地时间

  /*
   * 今天 - span * 86400000 是 span + 1 天，合计会把第 8 天也算进去，与热力图/趋势图同一个窗口对不上。
   * 0 或负数按 1 天算：合同上到不了，但不许算出倒置区间。
   */
  test('span 天含今天这一天：7 天从 10/1 起，30 天正好 30 格，跨年照常', () => {
    expect(windowOf(7, now)).toEqual({ from: '2026-10-01', to: '2026-10-07' })
    expect(windowOf(30, now)).toEqual({ from: '2026-09-08', to: '2026-10-07' })
    expect(windowOf(1, now)).toEqual({ from: '2026-10-07', to: '2026-10-07' })
    expect(windowOf(3, new Date(2027, 0, 1))).toEqual({ from: '2026-12-30', to: '2027-01-01' })
    expect(windowOf(0, now)).toEqual({ from: '2026-10-07', to: '2026-10-07' })
    expect(windowOf(-5, now)).toEqual({ from: '2026-10-07', to: '2026-10-07' })
  })
})

describe('模型名：按 provider/id 查显示名', () => {
  const series = [
    { model: 'deepseek/deepseek-v4-pro', label: 'deepseek/deepseek-v4-pro', days: [] },
    { model: 'anthropic/opus', label: 'anthropic/opus', days: [] },
  ]

  test('查到就换成名字，查不到的退回账上的别名，键（model）保持 provider/id', () => {
    const names = new Map([
      ['deepseek/deepseek-v4-pro', 'DeepSeek V4 Pro'],
      ['anthropic/opus', 'Opus'],
    ])
    expect(labelModels(series, names).map((l) => l.label)).toEqual(['DeepSeek V4 Pro', 'Opus'])
    expect(labelModels(series, names)[0]?.model).toBe('deepseek/deepseek-v4-pro')

    const partial = new Map([['deepseek/deepseek-v4-pro', 'DeepSeek V4 Pro']])
    expect(labelModels(series, partial).map((l) => l.label)).toEqual(['DeepSeek V4 Pro', 'anthropic/opus'])
  })

  test('空表原样交回，不造新数组', () => {
    expect(labelModels(series, new Map())).toBe(series)
  })
})
