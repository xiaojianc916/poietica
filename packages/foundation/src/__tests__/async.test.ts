import { describe, expect, test } from 'bun:test'
import { abortable, Deferred, delay, withTimeout } from '../async'
import { AppError } from '../errors'

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

describe('abortable', () => {
  test('中止后 reject 为 kernel.cancelled', async () => {
    const ac = new AbortController()
    const promise = abortable(new Promise<void>(() => {}), ac.signal)
    ac.abort()
    const error = await promise.catch((e: unknown) => e)
    expect(error).toBeInstanceOf(AppError)
    expect((error as AppError).code).toBe('kernel.cancelled')
  })
})

describe('delay', () => {
  test('中止后 reject 为 kernel.cancelled', async () => {
    const ac = new AbortController()
    const promise = delay(10_000, ac.signal)
    ac.abort()
    const error = await promise.catch((e: unknown) => e)
    expect((error as AppError).code).toBe('kernel.cancelled')
  })

  test('到时 resolve', async () => {
    await delay(1)
  })
})
