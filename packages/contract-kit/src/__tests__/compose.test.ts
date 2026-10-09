import { describe, expect, test } from 'bun:test'
import { AppError } from '@poietica/foundation'
import { z } from 'zod'
import { composeContracts } from '../compose'
import { defineContract, defineErrors, defineMethod, defineNotification } from '../define'

const empty = z.object({})
const code = (fn: () => unknown): string => {
  try {
    fn()
  } catch (e) {
    return e instanceof AppError ? e.code : 'not-app-error'
  }
  return 'no-error'
}

const contract = (over: Partial<Parameters<typeof defineContract>[0]> = {}) =>
  defineContract({
    id: 'demo',
    namespaces: ['demo'],
    methods: [],
    notifications: [],
    errors: defineErrors('demo', {}),
    ...over,
  } as never)

describe('composeContracts', () => {
  test('正常情况下 methods 含 core.shutdown', () => {
    const app = composeContracts(contract())
    expect(app.methods.has('core.shutdown')).toBe(true)
    expect(app.notifications.has('core.status')).toBe(true)
  })

  test('契约 id 重复 → kernel.contract_invalid', () => {
    expect(code(() => composeContracts(contract(), contract()))).toBe('kernel.contract_invalid')
  })

  test('命名空间被两个契约占用 → kernel.contract_invalid', () => {
    expect(code(() => composeContracts(contract(), contract({ id: 'other', namespaces: ['demo'] })))).toBe(
      'kernel.contract_invalid',
    )
  })

  test('方法名不合法 → kernel.contract_invalid', () => {
    for (const name of ['Terminal.open', 'terminal']) {
      const bad = contract({
        id: 'terminal',
        namespaces: ['terminal'],
        methods: [defineMethod({ name, owner: 'core', params: empty, result: empty, description: 'd' })],
        errors: defineErrors('terminal', {}),
      })
      expect(code(() => composeContracts(bad))).toBe('kernel.contract_invalid')
    }
  })

  test('名字不在命名空间内 → kernel.contract_invalid', () => {
    const bad = contract({
      methods: [defineMethod({ name: 'other.do', owner: 'core', params: empty, result: empty, description: 'd' })],
    })
    expect(code(() => composeContracts(bad))).toBe('kernel.contract_invalid')
  })

  test('方法与通知重名 → kernel.contract_invalid', () => {
    const bad = contract({
      methods: [defineMethod({ name: 'demo.x', owner: 'core', params: empty, result: empty, description: 'd' })],
      notifications: [defineNotification({ name: 'demo.x', owner: 'core', params: empty, description: 'd' })],
    })
    expect(code(() => composeContracts(bad))).toBe('kernel.contract_invalid')
  })

  test('错误码前缀与契约 id 不符 → kernel.contract_invalid', () => {
    const bad = contract({ errors: defineErrors('other', { x: 'm' }) })
    expect(code(() => composeContracts(bad))).toBe('kernel.contract_invalid')
  })

  test('功能契约使用 core 命名空间（与 system 冲突）→ kernel.contract_invalid', () => {
    const bad = contract({ namespaces: ['core'] })
    expect(code(() => composeContracts(bad))).toBe('kernel.contract_invalid')
  })
})
