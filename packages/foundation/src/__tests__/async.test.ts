import { describe, expect, test } from 'bun:test'
import { Deferred, mapLimited, withTimeout } from '../async'

describe('Deferred', () => {
  test('只 settle 一次', async () => {
    const d = new Deferred<number>()
    d.resolve(1)
    d.resolve(2)
    expect(await d.promise).toBe(1)
    expect(d.settled).toBe(true)
    const r = new Deferred<number>()
    r.reject(new Error('x'))
    r.resolve(1)
    await expect(r.promise).rejects.toThrow('x')
  })
})

describe('withTimeout', () => {
  test('超时 reject 为 onTimeout() 的错误', async () => {
    const slow = new Promise<void>(() => {})
    await expect(withTimeout(slow, 5, () => new Error('慢了'))).rejects.toThrow('慢了')
  })

  test('及时完成时不 reject', async () => {
    expect(await withTimeout(Promise.resolve('ok'), 1000, () => new Error('不该发生'))).toBe('ok')
  })
})
describe('mapLimited', () => {
  test('结果按输入顺序交回，同时在飞的不超过上限', async () => {
    let running = 0
    let peak = 0
    const seen: number[] = []
    const results = await mapLimited([5, 1, 3, 2, 4], 2, async (item, index) => {
      running += 1
      peak = Math.max(peak, running)
      seen.push(index)
      await new Promise((resolve) => setTimeout(resolve, item))
      running -= 1
      return item * 10
    })
    expect(results).toEqual([50, 10, 30, 20, 40])
    expect(peak).toBe(2)
    expect(seen).toHaveLength(5)
    expect([...new Set(seen)]).toHaveLength(5)
  })

  test('空表不调用任务', async () => {
    let calls = 0
    expect(
      await mapLimited([], 4, () => {
        calls += 1
        return 0
      }),
    ).toEqual([])
    expect(calls).toBe(0)
  })

  test('一个失败后不再领新任务，错误照实抛出', async () => {
    let calls = 0
    const failure = new Error('坏了')
    await expect(
      mapLimited([1, 2, 3, 4, 5], 1, async (item) => {
        calls += 1
        if (item === 2) throw failure
        return item
      }),
    ).rejects.toBe(failure)
    expect(calls).toBe(2)
  })

  test('非法并发上限是程序不变量，不是静默降级', async () => {
    await expect(mapLimited([1], 0, (item) => item)).rejects.toThrow('并发上限')
  })
})
