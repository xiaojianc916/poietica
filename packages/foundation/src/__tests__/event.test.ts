import { describe, expect, spyOn, test } from 'bun:test'
import { Emitter, onceEvent } from '../event'

describe('Emitter', () => {
  test('fire 通知全部监听器', () => {
    const emitter = new Emitter<number>()
    const seen: number[] = []
    emitter.event((v) => seen.push(v))
    emitter.event((v) => seen.push(v * 10))
    emitter.fire(2)
    expect(seen).toEqual([2, 20])
  })

  test('同一函数订阅两次收到两次，取消其中一个后收到一次', () => {
    const emitter = new Emitter<number>()
    let count = 0
    const listener = (): void => {
      count++
    }
    const first = emitter.event(listener)
    emitter.event(listener)
    emitter.fire(1)
    expect(count).toBe(2)
    first.dispose()
    emitter.fire(2)
    expect(count).toBe(3)
  })

  test('监听器抛错不影响其它监听器', () => {
    const spy = spyOn(console, 'error').mockImplementation(() => {})
    const emitter = new Emitter<number>()
    const seen: number[] = []
    emitter.event(() => {
      throw new Error('boom')
    })
    emitter.event((v) => seen.push(v))
    emitter.fire(1)
    expect(seen).toEqual([1])
    expect(spy).toHaveBeenCalledTimes(1)
    spy.mockRestore()
  })

  test('回调中新增的监听器本次不收到', () => {
    const emitter = new Emitter<number>()
    const seen: string[] = []
    emitter.event(() => {
      seen.push('first')
      emitter.event(() => seen.push('second'))
    })
    emitter.fire(1)
    // 新加的监听器不在本次通知的快照里，所以只看到 first
    expect(seen).toEqual(['first'])
    emitter.fire(2)
    // 第二次通知时它在快照里；第一个监听器又加了一个新的，要等下一次
    expect(seen).toEqual(['first', 'first', 'second'])
    expect(seen.filter((s) => s === 'second').length).toBe(1)
  })

  test('dispose 后 fire 无效果、订阅返回空 Disposable', () => {
    const emitter = new Emitter<number>()
    let count = 0
    emitter.event(() => {
      count++
    })
    emitter.dispose()
    emitter.fire(1)
    const d = emitter.event(() => {
      count++
    })
    d.dispose()
    expect(count).toBe(0)
    expect(emitter.hasListeners).toBe(false)
  })

  /*
   * R-08-4：给了 onListenerError 就交给它（调用方在这里带上 logger 与上下文），
   * 其余监听器照常收到，异常也不外抛给 fire 的调用方。
   */
  test('onListenerError 接住监听者异常，其它监听器仍然收到', () => {
    const seen: number[] = []
    const errors: unknown[] = []
    const emitter = new Emitter<number>({ onListenerError: (error) => errors.push(error) })
    const boom = new Error('boom')
    emitter.event(() => {
      throw boom
    })
    emitter.event((v) => seen.push(v))

    expect(() => emitter.fire(1)).not.toThrow()
    expect(errors).toEqual([boom])
    expect(seen).toEqual([1])
  })

  test('onListenerError 自己抛错也照旧不冲出去', () => {
    const spy = spyOn(console, 'error').mockImplementation(() => {})
    const emitter = new Emitter<number>({
      onListenerError: () => {
        throw new Error('handler 也炸了')
      },
    })
    emitter.event(() => {
      throw new Error('boom')
    })

    expect(() => emitter.fire(1)).not.toThrow()
    expect(spy).toHaveBeenCalled()
    spy.mockRestore()
  })
})

describe('onceEvent', () => {
  test('resolve 第一次的值', async () => {
    const emitter = new Emitter<number>()
    const promise = onceEvent(emitter.event)
    emitter.fire(7)
    expect(await promise).toBe(7)
  })

  test('signal 中止时 reject', async () => {
    const emitter = new Emitter<number>()
    const ac = new AbortController()
    const promise = onceEvent(emitter.event, ac.signal)
    ac.abort('stop')
    await expect(promise).rejects.toBe('stop')
  })
})
