import { describe, expect, test } from 'bun:test'
import type { ContextUsage } from '@poietica/engine'
import { effectiveUsage } from '../configuration/control-shapes'

/*
 * 用量有两条来源：推送 undefined = 从没收到过 → 用控件表初值；推送 null = 收到过「没有可报的窗口」→ 不回退。
 * 第二条是真缺陷的形状：换到没有窗口元数据的模型时若回退，屏幕上会留着上一个模型的旧数字。
 */

const CTX: ContextUsage = { usedTokens: 27_200, windowTokens: 1_000_000, breakdown: null }
const INITIAL = { context: CTX }

describe('上下文胶囊读哪一份用量', () => {
  test('还没收到推送时用控件表里的初值', () => {
    expect(effectiveUsage(undefined, INITIAL)).toEqual({
      used: 27_200,
      size: 1_000_000,
      inputOther: 0,
      inputCacheRead: 0,
      inputCacheCreation: 0,
      breakdown: null,
    })
  })

  test('收到推送之后以推送为准（它比初值新）', () => {
    const pushed: ContextUsage = { usedTokens: 500_000, windowTokens: 1_000_000, breakdown: null }

    expect(effectiveUsage(pushed, INITIAL)?.used).toBe(500_000)
  })

  test('推送是 null（报过「没有可报的窗口」）时不回退到初值', () => {
    expect(effectiveUsage(null, INITIAL)).toBeUndefined()
  })

  test('两条来源都没有就是不画', () => {
    expect(effectiveUsage(undefined, { context: null })).toBeUndefined()
    expect(effectiveUsage(undefined, null)).toBeUndefined()
  })

  test('构成明细原样透传（面板那七行按它画）', () => {
    const withBreakdown: ContextUsage = {
      usedTokens: 1_000,
      windowTokens: 10_000,
      breakdown: {
        systemPrompt: 100,
        systemTools: 200,
        systemContext: 300,
        skills: 0,
        messages: 400,
        free: 9_000,
        autoCompactBuffer: 0,
      },
    }

    expect(effectiveUsage(undefined, { context: withBreakdown })?.breakdown?.systemPrompt).toBe(100)
  })
})
