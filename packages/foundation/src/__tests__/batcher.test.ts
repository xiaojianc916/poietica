import { describe, expect, test } from 'bun:test'
import { Batcher } from '../batcher'
import type { Clock } from '../clock'
import { type Disposable, toDisposable } from '../disposable'

/** 最小假时钟：setTimeout 只记录回调，由测试手动触发 */
function fakeClock(): { clock: Clock; runTimers(): void; pending(): number } {
  const timers = new Set<() => void>()
  return {
    clock: {
      now: () => 0,
      setTimeout(fn: () => void): Disposable {
        timers.add(fn)
        return toDisposable(() => timers.delete(fn))
      },
      setInterval(): Disposable {
        return toDisposable(() => {})
      },
    },
    runTimers(): void {
      for (const fn of [...timers]) {
        timers.delete(fn)
        fn()
      }
    },
    pending: () => timers.size,
  }
}

describe('Batcher', () => {
  test('两次 push 只 flush 一次且内容为全部条目', () => {
    const { clock, runTimers } = fakeClock()
    const batches: string[][] = []
    const batcher = new Batcher<string>({ delayMs: 16, flush: (items) => batches.push(items), clock })
    batcher.push('a')
    batcher.push('b')
    expect(batches).toEqual([])
    runTimers()
    expect(batches).toEqual([['a', 'b']])
  })

  test('maxItems 达到上限时立即 flush', () => {
    const { clock } = fakeClock()
    const batches: string[][] = []
    const batcher = new Batcher<string>({ delayMs: 16, maxItems: 2, flush: (items) => batches.push(items), clock })
    batcher.push('a')
    expect(batches).toEqual([])
    batcher.push('b')
    expect(batches).toEqual([['a', 'b']])
  })

  test('dispose flush 剩余条目，之后 push 被忽略', () => {
    const { clock } = fakeClock()
    const batches: string[][] = []
    const batcher = new Batcher<string>({ delayMs: 16, flush: (items) => batches.push(items), clock })
    batcher.push('a')
    batcher.dispose()
    expect(batches).toEqual([['a']])
    batcher.push('b')
    expect(batches).toEqual([['a']])
  })
})
