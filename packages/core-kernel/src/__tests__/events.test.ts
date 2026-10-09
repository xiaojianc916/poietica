import { describe, expect, test } from 'bun:test'
import { type AppError, SystemErrorCode } from '@poietica/foundation'
import { createTestLogger } from '@poietica/test-kit'
import { createEventHub, defineCoreEvent } from '../events'

const alphaTick = defineCoreEvent<{ n: number }>('alpha', 'tick')
const betaTick = defineCoreEvent<{ n: number }>('beta', 'tick')

describe('core 进程内事件', () => {
  test('订阅、退订、按令牌分发', () => {
    const hub = createEventHub()
    const log = createTestLogger()
    const seen: number[] = []
    const bus = hub.scoped('alpha', [], log)
    const sub = bus.on(alphaTick, (p) => {
      seen.push(p.n)
    })
    bus.emit(alphaTick, { n: 1 })
    sub.dispose()
    bus.emit(alphaTick, { n: 2 })
    expect(seen).toEqual([1])
  })

  test('emit 不属于自己的事件 → kernel.service_access_denied', () => {
    const hub = createEventHub()
    const bus = hub.scoped('alpha', [], createTestLogger())
    try {
      bus.emit(betaTick, { n: 1 })
    } catch (e) {
      expect((e as AppError).code).toBe(SystemErrorCode.serviceAccessDenied)
    }
  })

  test('订阅前必须在 dependsOn 中声明 ownerModule', () => {
    const hub = createEventHub()
    const bus = hub.scoped('beta', [], createTestLogger())
    try {
      bus.on(alphaTick, () => undefined)
    } catch (e) {
      expect((e as AppError).code).toBe(SystemErrorCode.serviceAccessDenied)
      expect((e as AppError).message).toContain("'alpha'")
    }
  })

  test('声明了 dependsOn 就能订阅别人的事件', () => {
    const hub = createEventHub()
    const a = hub.scoped('alpha', [], createTestLogger())
    const b = hub.scoped('beta', ['alpha'], createTestLogger())
    const seen: number[] = []
    b.on(alphaTick, (p) => {
      seen.push(p.n)
    })
    a.emit(alphaTick, { n: 3 })
    expect(seen).toEqual([3])
  })

  test('同步分发、按订阅顺序', () => {
    const hub = createEventHub()
    const bus = hub.scoped('alpha', [], createTestLogger())
    const order: string[] = []
    bus.on(alphaTick, () => {
      order.push('first')
    })
    bus.on(alphaTick, () => {
      order.push('second')
    })
    bus.emit(alphaTick, { n: 1 })
    expect(order).toEqual(['first', 'second'])
  })

  test('订阅方的异常不影响发出方，只记 error 日志', () => {
    const hub = createEventHub()
    const log = createTestLogger()
    const bus = hub.scoped('alpha', [], log)
    let reached = false
    bus.on(alphaTick, () => {
      throw new Error('坏了')
    })
    bus.on(alphaTick, () => {
      reached = true
    })
    bus.emit(alphaTick, { n: 1 })
    expect(reached).toBe(true)
    expect(log.at('error').some((r) => r.msg === 'event handler threw')).toBe(true)
  })

  test('异步订阅方 reject 时记 error 而不影响发出方', async () => {
    const hub = createEventHub()
    const log = createTestLogger()
    const bus = hub.scoped('alpha', [], log)
    bus.on(alphaTick, async () => {
      throw new Error('异步坏了')
    })
    bus.emit(alphaTick, { n: 1 })
    await new Promise((r) => setTimeout(r, 5))
    expect(log.at('error').some((r) => r.msg === 'event handler rejected')).toBe(true)
  })

  test('发出方不等待异步处理完成', () => {
    const hub = createEventHub()
    const bus = hub.scoped('alpha', [], createTestLogger())
    let done = false
    bus.on(alphaTick, async () => {
      await new Promise((r) => setTimeout(r, 20))
      done = true
    })
    bus.emit(alphaTick, { n: 1 })
    expect(done).toBe(false)
  })

  test('两个模块各自定义同名事件是两个不同的令牌', () => {
    const hub = createEventHub()
    const a = hub.scoped('alpha', [], createTestLogger())
    const b = hub.scoped('beta', [], createTestLogger())
    const seenA: number[] = []
    a.on(alphaTick, (p) => {
      seenA.push(p.n)
    })
    b.emit(betaTick, { n: 9 })
    expect(seenA).toEqual([])
  })
})
