import { describe, expect, test } from 'bun:test'
import { usageOf } from '../usage'

describe('usageOf', () => {
  test('非 assistant 消息或没有 usage 时返回 null', () => {
    expect(usageOf({ role: 'user' }, 0)).toBeNull()
    expect(usageOf({ role: 'assistant' }, 0)).toBeNull()
  })

  test('全为 0 时返回 null（不发事件）', () => {
    expect(usageOf({ role: 'assistant', usage: { input: 0, output: 0 } }, 0)).toBeNull()
  })

  test('读出 input/output/cache 与 cost.total', () => {
    const sample = usageOf(
      {
        role: 'assistant',
        provider: 'anthropic',
        model: 'claude',
        usage: { input: 10, output: 20, cacheRead: 3, cacheWrite: 4, cost: { total: 0.5 } },
      },
      123,
    )
    expect(sample).toEqual({
      provider: 'anthropic',
      model: 'claude',
      input: 10,
      output: 20,
      cacheRead: 3,
      cacheWrite: 4,
      cost: 0.5,
      at: 123,
    })
  })

  test('负数与非数字一律归零', () => {
    const sample = usageOf({ role: 'assistant', usage: { input: -5, outputTokens: 'x', cost: 1 } }, 0)
    expect(sample?.input).toBe(0)
    expect(sample?.output).toBe(0)
    expect(sample?.cost).toBe(1)
  })
})
