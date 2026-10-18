import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { defineErrors, defineMethod, defineNotification } from '../define'

describe('defineMethod / defineNotification', () => {
  test('defineMethod 默认 timeoutMs 为 30_000，返回对象被冻结', () => {
    const m = defineMethod({
      name: 'demo.do',
      owner: 'core',
      params: z.object({ a: z.string() }),
      result: z.object({}),
      description: '做',
    })
    expect(m.timeoutMs).toBe(30_000)
    expect(Object.isFrozen(m)).toBe(true)
  })

  test('defineNotification 冻结且 kind 正确', () => {
    const n = defineNotification({ name: 'demo.changed', owner: 'host', params: z.object({}), description: '变了' })
    expect(n.kind).toBe('notification')
    expect(Object.isFrozen(n)).toBe(true)
  })
})

describe('defineErrors', () => {
  test('键映射为 <ns>.<key>，__messages 同步', () => {
    const errors = defineErrors('terminal', { not_found: 'x' })
    expect(errors.not_found).toBe('terminal.not_found')
    expect(errors.__messages['terminal.not_found']).toBe('x')
  })
})
