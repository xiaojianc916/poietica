import { describe, expect, test } from 'bun:test'
import { computeMetrics, judge, type Sample } from '../metrics'

/* 阈值判错时，人看到的是「检查自己乱报」，那种检查没人会信。 */

const at = (t: number, extra: Partial<Sample> = {}): Sample => ({
  t,
  key: 0,
  shown: 1,
  /* 默认「还有字在路上」：绝大多数用例量的是正在出字时的行为。 */
  arrived: 99,
  offset: 0,
  firstL: 100,
  lastR: 200,
  winL: 100,
  winR: 500,
  winW: 400,
  trackW: 300,
  ...extra,
})

const arrivals = [
  { at: 100, length: 10 },
  { at: 200, length: 20 },
]

describe('右侧裁到字', () => {
  test('最后一个字的右边界越过窗口右边界就算一帧', () => {
    const metrics = computeMetrics([at(10), at(20, { lastR: 500.4 }), at(30, { lastR: 500.6 })], arrivals)

    expect(metrics.rightClip).toBe(1)
  })
})

describe('放得下时句首被裁', () => {
  test('只有轨道不比窗口宽时才算：放不下时往左溢出是它的正常样子', () => {
    const fits = computeMetrics([at(10, { firstL: 98 }), at(20, { firstL: 100 })], arrivals)

    expect(fits.leftCutWhileFits).toBe(1)

    const overflows = computeMetrics([at(10, { firstL: 50, trackW: 600 })], arrivals)

    expect(overflows.leftCutWhileFits).toBe(0)
  })
})

describe('新字出现延迟', () => {
  test('从这一批到达的时刻，到这一批第一个字印出来的时刻', () => {
    /* 第 2 批（长度 20）的第 1 个字是全文第 11 个字：offset 0 + shown 11 就够。 */
    const samples = [at(150, { shown: 5 }), at(260, { shown: 11 })]
    const metrics = computeMetrics(samples, arrivals)

    expect(metrics.latency).toEqual([60])
  })

  test('当前句只印它自己那一段：起始偏移要加回去', () => {
    /* 句子从原文第 30 个字开始，屏幕上印了 6 个字 = 印到第 36 个。 */
    const samples = [at(310, { key: 30, shown: 6 })]
    const metrics = computeMetrics(samples, arrivals)

    expect(metrics.latency).toEqual([110])
  })

  test('一直没印出来记 9999，p50/p95 照常给出', () => {
    const metrics = computeMetrics([at(10)], arrivals)

    expect(metrics.max).toBe(9999)
    expect(metrics.p50).toBe(9999)
  })
})

describe('应动未动与平滑度', () => {
  test('同一句、溢出、正在出字：句首没动的帧算应动未动', () => {
    /* 前 300ms 是起步，不算（见 metrics 的注释）：所以采样从 300ms 起。 */
    const samples = [
      at(300, { firstL: 100, trackW: 600 }),
      at(400, { firstL: 100, trackW: 600 }),
      at(500, { firstL: 90, trackW: 620 }),
      at(600, { firstL: 80, trackW: 640 }),
    ]
    const metrics = computeMetrics(samples, [
      { at: 0, length: 10 },
      { at: 900, length: 20 },
    ])

    /* 三对相邻帧里第一对没动（100→100），另外两对各动了 10px。 */
    expect(metrics.stallFrac).toBeCloseTo(1 / 3, 5)
  })

  test('换句那一跳不算运动：key 变了就跳过', () => {
    const samples = [
      at(0, { key: 0, firstL: 100, trackW: 600 }),
      at(100, { key: 5, firstL: 300, trackW: 600 }),
      at(200, { key: 5, firstL: 290, trackW: 620 }),
    ]
    const metrics = computeMetrics(samples, [
      { at: 0, length: 10 },
      { at: 900, length: 20 },
    ])

    expect(metrics.stallFrac).toBe(0)
  })

  test('不溢出时不算：那种静止不是「应动未动」', () => {
    const samples = [at(0, { trackW: 300 }), at(100, { trackW: 300 })]
    const metrics = computeMetrics(samples, [
      { at: 0, length: 10 },
      { at: 900, length: 20 },
    ])

    expect(metrics.stallFrac).toBe(0)
  })

  test('停笔之后不算：到到达的字都印完了，句首本来就不该动', () => {
    /* 前 100ms 里印到的位置追上了到达长度（20 = 20）：那是停笔，不是没动。 */
    const samples = [
      at(300, { firstL: 100, shown: 20, arrived: 20, trackW: 600 }),
      at(400, { firstL: 100, shown: 20, arrived: 40, trackW: 600 }),
      at(500, { firstL: 95, shown: 21, arrived: 40, trackW: 610 }),
    ]
    const metrics = computeMetrics(samples, [
      { at: 0, length: 20 },
      { at: 900, length: 40 },
    ])

    /* 两对都算「正在出字」：第一对没动（应动未动），第二对动了 5px。 */
    expect(metrics.stallFrac).toBeCloseTo(0.5, 5)
  })

  test('平滑度：相邻两帧速度的相对变化按第 90 百分位取', () => {
    /* 视觉位移 100 / 110 / 130 / 160 px/s：最后那一对跳得最大。 */
    const firsts = [700, 600, 500, 370, 210]
    const samples = firsts.map((firstL, index) => at(300 + index * 100, { firstL, trackW: 600 }))
    const metrics = computeMetrics(samples, [
      { at: 0, length: 10 },
      { at: 900, length: 20 },
    ])

    expect(metrics.sJ90).toBeCloseTo(0.2609, 4)
  })
})

describe('阈值判定', () => {
  test('遮字一律不合格：与性能无关', () => {
    const metrics = computeMetrics([at(10, { lastR: 600 })], [])
    const failures = judge(metrics, { latencyP95Ms: 500, stallFrac: 0.1, sJ90: 0.25 })

    expect(failures.some((failure) => failure.includes('右侧裁到字'))).toBe(true)
  })

  test('延迟按毫秒比阈值', () => {
    const metrics = computeMetrics(
      [at(10)],
      [
        { at: 0, length: 1 },
        { at: 1, length: 2 },
      ],
    )
    const failures = judge(metrics, { latencyP95Ms: 500, stallFrac: 0.1, sJ90: 0.25 })

    expect(failures.some((failure) => failure.includes('延迟'))).toBe(true)
  })

  test('全过时没有失败项', () => {
    const metrics = computeMetrics([], [])
    const failures = judge(metrics, { latencyP95Ms: 500, stallFrac: 0.1, sJ90: 0.25 })

    expect(failures).toEqual([])
  })
})
