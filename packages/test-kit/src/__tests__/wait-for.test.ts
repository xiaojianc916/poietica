import { describe, expect, test } from 'bun:test'
import { waitFor } from '../wait-for'

describe('waitFor', () => {
  test('第 3 次返回真值时 resolve 该值', async () => {
    let calls = 0
    const value = await waitFor(
      () => {
        calls++
        return calls >= 3 ? `第 ${calls} 次` : null
      },
      { intervalMs: 1 },
    )
    expect(value).toBe('第 3 次')
    expect(calls).toBe(3)
  })

  test('超时错误信息含最后一次抛出的错误信息', async () => {
    const error = await waitFor(
      () => {
        throw new Error('最后一击')
      },
      { timeoutMs: 30, intervalMs: 5, message: '等了很久' },
    ).catch((e: unknown) => e)
    expect((error as Error).message).toContain('等了很久')
    expect((error as Error).message).toContain('最后一击')
  })
})
