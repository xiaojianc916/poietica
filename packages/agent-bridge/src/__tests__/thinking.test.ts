/*
 * 思考档位的两条判据：候选就是模型自己的梯子，收敛只落在梯子上。
 *
 * 这一格是「屏幕上那几档」的唯一产地，所以逐条钉住：写死一张通用表的代码会在这里红。
 *
 * 自检跑法：bun test src/__tests__/thinking.test.ts
 */

import { describe, expect, it } from 'bun:test'
import { settleThinking, type ThinkingSession, thinkingToSettle } from '../thinking.ts'

/** 一条只记「被设成了什么」的假会话：规则本身与进程无关。 */
function session(options: {
  levels: readonly string[]
  current: string | undefined
  defaultLevel?: string | undefined
}): ThinkingSession & { readonly set: string[] } {
  const set: string[] = []

  return {
    set,
    agent: {
      getAvailableThinkingLevels: () => options.levels,
      configuredThinkingLevel: () => options.current,
      model: {
        thinking: options.defaultLevel === undefined ? {} : { defaultLevel: options.defaultLevel },
      },
      setThinkingLevel: (level) => {
        set.push(level as unknown as string)
      },
    },
  }
}

describe('收敛到哪一档', () => {
  it('已经在梯子上就不动 —— 不重发、不覆盖用户的选择', () => {
    expect(thinkingToSettle('max', ['low', 'high', 'max'], 'high', 'high')).toBeUndefined()
  })

  it('旧版本留下的 off 要收掉', () => {
    expect(thinkingToSettle('off', ['low', 'high', 'max'], 'high', 'high')).toBe('high')
    expect(thinkingToSettle('off', ['low', 'high', 'max'], undefined, 'high')).toBe('high')
  })

  it('旧版本留下的 auto 也收掉 —— 它每轮多花一次分类调用', () => {
    expect(thinkingToSettle('auto', ['low', 'high', 'max'], 'high', 'high')).toBe('high')
  })

  it('换过模型之后停在另一条模型的档位上，收敛到这条模型认的默认档', () => {
    expect(thinkingToSettle('medium', ['low', 'high', 'max'], 'high', 'high')).toBe('high')
  })

  it('模型自己声明的默认档优先于全局默认', () => {
    expect(thinkingToSettle('off', ['low', 'high', 'max'], 'max', 'low')).toBe('max')
  })

  it('全默认都不在这条梯子上时取它能给的最深一档 —— 深度思考默认开启', () => {
    expect(thinkingToSettle('auto', ['low', 'high'], undefined, 'max')).toBe('high')
    expect(thinkingToSettle('off', ['high'], undefined, 'low')).toBe('high')
  })

  it('非推理模型（没有梯子）一档都不给', () => {
    expect(thinkingToSettle('off', [], 'high', 'high')).toBeUndefined()
  })
})

describe('落到会话上的那一动', () => {
  it('该动才动，动就动一次', () => {
    const settled = session({
      levels: ['low', 'high', 'max'],
      current: 'auto',
      defaultLevel: 'high',
    })

    settleThinking(settled, 'high')

    expect(settled.set).toEqual(['high'])
  })

  it('不需要动的时候一次都不写 —— 否则每开一次会话都记一条改动', () => {
    const settled = session({
      levels: ['low', 'high', 'max'],
      current: 'max',
      defaultLevel: 'high',
    })

    settleThinking(settled, 'high')

    expect(settled.set).toEqual([])
  })

  it('没有梯子（不思考的模型）不写', () => {
    const settled = session({ levels: [], current: 'off' })

    settleThinking(settled, 'high')

    expect(settled.set).toEqual([])
  })
})
