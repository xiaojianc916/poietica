import { describe, expect, test } from 'bun:test'
import { DisposableStore, toDisposable } from '../disposable'

describe('toDisposable', () => {
  test('多次 dispose 只调用一次', () => {
    let calls = 0
    const d = toDisposable(() => {
      calls++
    })
    d.dispose()
    d.dispose()
    expect(calls).toBe(1)
  })
})

describe('DisposableStore', () => {
  test('按添加的逆序释放', () => {
    const store = new DisposableStore()
    const order: number[] = []
    store.add(toDisposable(() => order.push(1)))
    store.add(toDisposable(() => order.push(2)))
    store.add(toDisposable(() => order.push(3)))
    store.dispose()
    expect(order).toEqual([3, 2, 1])
  })

  test('中间一项抛错，其余仍被释放，最后抛 AggregateError', () => {
    const store = new DisposableStore()
    const order: number[] = []
    store.add(toDisposable(() => order.push(1)))
    store.add(
      toDisposable(() => {
        order.push(2)
        throw new Error('boom')
      }),
    )
    store.add(toDisposable(() => order.push(3)))
    let caught: unknown
    try {
      store.dispose()
    } catch (e) {
      caught = e
    }
    expect(order).toEqual([3, 2, 1])
    expect(caught).toBeInstanceOf(AggregateError)
    expect((caught as AggregateError).errors.length).toBe(1)
  })

  test('dispose 之后 add 的资源立即释放', () => {
    const store = new DisposableStore()
    store.dispose()
    let disposed = false
    store.add(
      toDisposable(() => {
        disposed = true
      }),
    )
    expect(disposed).toBe(true)
    expect(store.isDisposed).toBe(true)
  })

  test('重复 dispose 无效果', () => {
    const store = new DisposableStore()
    let calls = 0
    store.add(
      toDisposable(() => {
        calls++
      }),
    )
    store.dispose()
    store.dispose()
    expect(calls).toBe(1)
  })
})
