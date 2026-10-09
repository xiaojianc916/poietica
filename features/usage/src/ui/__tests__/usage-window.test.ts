import { describe, expect, it } from 'bun:test'
import { windowOf } from '../api'
import { labelModels } from '../model-labels'

/*
 * 窗口算式与模型名：两处都是「看着对但差一格」的地方，因此各钉一条。
 */

describe('窗口：最近 span 天，含今天', () => {
  const now = new Date(2026, 9, 7, 15, 30) // 2026-10-07 本地时间

  it('7 天 = 从 10/1 到 10/7（不是 10/8 天）', () => {
    expect(windowOf(7, now)).toEqual({ from: '2026-10-01', to: '2026-10-07' })
  })

  /*
   * 此前写的是 今天 - span * 86400000：那是 span + 1 天，合计会把第 8 天也算进去，
   * 与热力图/趋势图同一个窗口对不上。这条钉的就是那一格。
   */
  it('30 天 = 从 9/8 到 10/7，跨度正好 30 格', () => {
    const found = windowOf(30, now)

    expect(found.from).toBe('2026-09-08')
    expect(found.to).toBe('2026-10-07')
  })

  it('1 天 = 今天这一天', () => {
    expect(windowOf(1, now)).toEqual({ from: '2026-10-07', to: '2026-10-07' })
  })

  /* 跨月、跨年都交给 Date 的构造器归一，不自己算天数。 */
  it('跨年照常', () => {
    expect(windowOf(3, new Date(2027, 0, 1))).toEqual({ from: '2026-12-30', to: '2027-01-01' })
  })

  it('0 或负数按 1 天算（合同上到不了，但不许算出倒置区间）', () => {
    expect(windowOf(0, now)).toEqual({ from: '2026-10-07', to: '2026-10-07' })
    expect(windowOf(-5, now)).toEqual({ from: '2026-10-07', to: '2026-10-07' })
  })
})

describe('模型名：按 provider/id 查显示名', () => {
  const series = [
    { model: 'deepseek/deepseek-v4-pro', label: 'deepseek/deepseek-v4-pro', days: [] },
    { model: 'anthropic/opus', label: 'anthropic/opus', days: [] },
  ]

  it('查到就换成名字', () => {
    const names = new Map([
      ['deepseek/deepseek-v4-pro', 'DeepSeek V4 Pro'],
      ['anthropic/opus', 'Opus'],
    ])

    expect(labelModels(series, names).map((l) => l.label)).toEqual(['DeepSeek V4 Pro', 'Opus'])
  })

  /* 目录里没有的退回别名：显示一个我们不认识的名字比显示 provider/id 更糟。 */
  it('查不到的退回账上的别名', () => {
    const names = new Map([['deepseek/deepseek-v4-pro', 'DeepSeek V4 Pro']])

    expect(labelModels(series, names).map((l) => l.label)).toEqual(['DeepSeek V4 Pro', 'anthropic/opus'])
  })

  /* 目录还没到时整份交回来（引用不变）：调用方按引用比，不必每帧重算。 */
  it('空表原样交回，不造新数组', () => {
    expect(labelModels(series, new Map())).toBe(series)
  })

  it('不改账上的 model 字段（图例换的是显示名，键仍是 provider/id）', () => {
    const names = new Map([['deepseek/deepseek-v4-pro', 'DeepSeek V4 Pro']])
    const labelled = labelModels(series, names)

    expect(labelled[0]?.model).toBe('deepseek/deepseek-v4-pro')
  })
})
