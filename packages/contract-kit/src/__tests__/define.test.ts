import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { defineContract, defineErrors, defineMethod, defineNotification } from '../define'
import type { ParamsOut } from '../types'

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

describe('类型推导', () => {
  test('ParamsOut 从契约推导出输出类型', () => {
    const c = defineContract({
      id: 'demo',
      namespaces: ['a'],
      methods: [
        defineMethod({
          name: 'a.b',
          owner: 'core',
          params: z.object({ text: z.string(), count: z.number().default(1) }),
          result: z.object({}),
          description: 'd',
        }),
      ],
      notifications: [],
      errors: defineErrors('demo', {}),
    })
    const good: ParamsOut<typeof c, 'a.b'> = { text: 'x', count: 2 }
    expect(good.count).toBe(2)
    /* 缺 text 在类型层被拒绝（不用抑制注释，铁律 3）：断言这个「不可赋值」为真。 */
    type MissingRejected = { count: number } extends ParamsOut<typeof c, 'a.b'> ? never : true
    const missingRejected: MissingRejected = true
    expect(missingRejected).toBe(true)
  })
})
