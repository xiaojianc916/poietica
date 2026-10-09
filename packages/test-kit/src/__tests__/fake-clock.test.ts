import { describe, expect, test } from 'bun:test'
import { fakeClock } from '../fake-clock'

describe('fakeClock', () => {
  test('advance(99) 未执行、advance(1) 执行', () => {
    const clock = fakeClock()
    let fired = 0
    clock.setTimeout(() => {
      fired++
    }, 100)
    clock.advance(99)
    expect(fired).toBe(0)
    clock.advance(1)
    expect(fired).toBe(1)
  })

  test('同时到期的定时器按创建顺序执行', () => {
    const clock = fakeClock()
    const order: number[] = []
    clock.setTimeout(() => order.push(1), 50)
    clock.setTimeout(() => order.push(2), 50)
    clock.advance(50)
    expect(order).toEqual([1, 2])
  })

  test('定时器回调里新建的定时器在同一次 advance 内也会执行', () => {
    const clock = fakeClock()
    const order: string[] = []
    clock.setTimeout(() => {
      order.push('first')
      clock.setTimeout(() => order.push('second'), 10)
    }, 5)
    clock.advance(200)
    expect(order).toEqual(['first', 'second'])
  })

  test('setInterval 按间隔重复执行', () => {
    const clock = fakeClock()
    let count = 0
    clock.setInterval(() => {
      count++
    }, 50)
    clock.advance(200)
    expect(count).toBe(4)
    expect(clock.now()).toBe(1_700_000_000_000 + 200)
  })

  test('dispose 后不执行，pendingTimers 减少', () => {
    const clock = fakeClock()
    let fired = 0
    const handle = clock.setTimeout(() => {
      fired++
    }, 10)
    expect(clock.pendingTimers()).toBe(1)
    handle.dispose()
    expect(clock.pendingTimers()).toBe(0)
    clock.advance(100)
    expect(fired).toBe(0)
  })

  test('advanceAsync：定时器 resolve 的 Promise 的 then 在返回前已执行', async () => {
    const clock = fakeClock()
    const seen: string[] = []
    let resolveFn: (() => void) | undefined
    clock.setTimeout(() => resolveFn?.(), 10)
    const promise = new Promise<void>((resolve) => {
      resolveFn = resolve
    }).then(() => {
      seen.push('then')
    })
    await clock.advanceAsync(20)
    expect(seen).toEqual(['then'])
    await promise
  })

  test('runAllTimeouts 不执行间隔定时器', () => {
    const clock = fakeClock()
    let intervals = 0
    let timeouts = 0
    clock.setInterval(() => {
      intervals++
    }, 1)
    clock.setTimeout(() => {
      timeouts++
    }, 1)
    clock.runAllTimeouts()
    expect(timeouts).toBe(1)
    expect(intervals).toBe(0)
    expect(clock.pendingTimers()).toBe(1)
  })
})
