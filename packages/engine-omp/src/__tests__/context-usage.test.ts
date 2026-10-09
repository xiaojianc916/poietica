import { describe, expect, test } from 'bun:test'
import { toContextUsage } from '../context-usage'

/*
 * omp 的上下文读数 → 引擎端口。
 *
 * 这里的**字段名**是真机故障「输入框没有用量显示」的根因：omp 的 getContextUsage() 报的是
 * { tokens, contextWindow }（pi-tui 的 status-line/types），而适配器原先按
 * { usedTokens, windowTokens } 去读 —— 两个名字都不存在，于是恒为 undefined、恒被判成
 * 「会话还没报过」，那颗圆环永远不画。第一条用例拿真实 SDK 形状喂进去，按旧名读会红。
 *
 * 构成明细取自 omp 自己的 computeContextBreakdown（/context 面板那一份）。本文件只钉
 * **映射**：哪个字段进哪一格、缺了退哪里。面板上的读数与分段算法在 features/conversation
 * 的 context-gauge 里另有其测试。
 */

/** 真实 SDK 的返回形状（pi-tui 的 ContextUsage） */
const SDK_USAGE = { tokens: 27_200, contextWindow: 1_000_000, percent: 3 }

/** 真实 SDK 的构成形状（pi-tui 的 ContextBreakdown，只留本仓真读的那几格） */
const SDK_BREAKDOWN = {
  contextWindow: 1_000_000,
  usedTokens: 27_200,
  categories: [
    { id: 'systemPrompt', tokens: 2_500 },
    { id: 'systemTools', tokens: 3_400 },
    { id: 'systemContext', tokens: 466 },
    { id: 'skills', tokens: 28 },
    { id: 'messages', tokens: 20_806 },
  ],
  freeTokens: 822_800,
  autoCompactBufferTokens: 150_000,
}

describe('omp 的上下文读数 → 引擎端口', () => {
  test('按真实 SDK 的字段名读：tokens / contextWindow，不是 usedTokens / windowTokens', () => {
    expect(toContextUsage(SDK_USAGE, undefined)).toEqual({
      usedTokens: 27_200,
      windowTokens: 1_000_000,
      breakdown: null,
    })
  })

  /*
   * 逐格对位。这一类映射最容易犯的错是串格（tools 与 context 写反、free 与 buffer 写反），
   * 而串格不会让任何一条求和或总数断言变红 —— 只能逐格钉。
   */
  test('构成逐格对位（含 free / autoCompactBuffer 不串格）', () => {
    expect(toContextUsage(SDK_USAGE, SDK_BREAKDOWN)?.breakdown).toEqual({
      systemPrompt: 2_500,
      systemTools: 3_400,
      systemContext: 466,
      skills: 28,
      messages: 20_806,
      free: 822_800,
      autoCompactBuffer: 150_000,
    })
  })

  /*
   * 没有分母就整体交 null：ContextGauge 按 size <= 0 不画（正本同此）。报 0 会画出一颗
   * 永远空的圆环，那比不画更像故障 —— 这一格是「窗口未知」唯一的收敛点。
   */
  test('窗口未知（没有分母）时整体交 null，不报 0', () => {
    expect(toContextUsage({ tokens: 1_000 }, undefined)).toBeNull()
    expect(toContextUsage({ contextWindow: 200_000 }, undefined)).toBeNull()
    expect(toContextUsage({ tokens: 1_000, contextWindow: 0 }, undefined)).toBeNull()
    expect(toContextUsage(undefined, undefined)).toBeNull()
  })

  /* 读数缺了退构成里那两格；两条都没有才是真的不报。 */
  test('getContextUsage 缺了退构成里那两格', () => {
    expect(toContextUsage(undefined, SDK_BREAKDOWN)?.usedTokens).toBe(27_200)
    expect(toContextUsage(undefined, SDK_BREAKDOWN)?.windowTokens).toBe(1_000_000)
  })

  /* 认不出的分类 id 当 0：omp 将来加一格不该让整份构成作废。 */
  test('认不出的分类当 0，不把整份构成作废', () => {
    const usage = toContextUsage(SDK_USAGE, {
      ...SDK_BREAKDOWN,
      categories: [
        { id: 'systemPrompt', tokens: 100 },
        { id: 'brandNewCategory', tokens: 999 },
      ],
    })

    expect(usage?.breakdown?.systemPrompt).toBe(100)
    expect(usage?.breakdown?.messages).toBe(0)
  })

  /* NaN / Infinity 递给屏幕就是 NaN 那样的读数，按缺席处置。 */
  test('非有限数按缺席处置，不把 NaN 递给屏幕', () => {
    expect(toContextUsage({ tokens: Number.NaN, contextWindow: 1_000 }, undefined)).toBeNull()
    expect(toContextUsage({ tokens: 10, contextWindow: Number.POSITIVE_INFINITY }, undefined)).toBeNull()
  })
})
