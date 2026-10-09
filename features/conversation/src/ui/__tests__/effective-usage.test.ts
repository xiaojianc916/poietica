import { describe, expect, test } from 'bun:test'
import type { ContextUsage } from '@poietica/engine'
import { effectiveUsage } from '../control-shapes'

/*
 * 屏幕上那一份用量有**两条来源**，这一份钉的是它俩的优先级。
 *
 * 判据全落在 undefined 与 null 分不分得开：
 *
 * - 推送是 undefined = 这条对话从没收到过用量推送（刚打开、还没跑过）→ 用控件表里的初值；
 * - 推送是 null = **收到过**一次「此刻没有可报的窗口」→ 就是没有，不回退到初值。
 *
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

  /* 「换到无窗口模型」那条路：推送说没有，就不许再拿旧初值顶上。 */
  test('推送是 null（报过「没有可报的窗口」）时不回退到初值', () => {
    expect(effectiveUsage(null, INITIAL)).toBeUndefined()
  })

  test('两条来源都没有就是不画', () => {
    expect(effectiveUsage(undefined, { context: null })).toBeUndefined()
    expect(effectiveUsage(undefined, null)).toBeUndefined()
  })

  /* 构成明细要原样透传到胶囊：漏掉它，面板那七行就永远是空的。 */
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
