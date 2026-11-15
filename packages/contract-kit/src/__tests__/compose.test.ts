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

  /* 装配期校验：id / 命名空间 / 名字 / 错误码前缀任何一处不合法，都拒绝整批契约。 */
  test('id 重复、命名空间被占、名字不合法或不在命名空间内、方法与通知重名、错误码前缀不符、占用 core 命名空间 —— 全部 kernel.contract_invalid', () => {
    const method = (name: string) =>
      defineMethod({ name, owner: 'core', params: empty, result: empty, description: 'd' })

    const bads = [
      () => composeContracts(contract(), contract()),
      () => composeContracts(contract(), contract({ id: 'other', namespaces: ['demo'] })),
      ...['Terminal.open', 'terminal'].map(
        (name) => () =>
          composeContracts(
            contract({
              id: 'terminal',
              namespaces: ['terminal'],
              methods: [method(name)],
              errors: defineErrors('terminal', {}),
            }),
          ),
      ),
      () => composeContracts(contract({ methods: [method('other.do')] })),
      () =>
        composeContracts(
          contract({
            methods: [method('demo.x')],
            notifications: [defineNotification({ name: 'demo.x', owner: 'core', params: empty, description: 'd' })],
          }),
        ),
      () => composeContracts(contract({ errors: defineErrors('other', { x: 'm' }) })),
      () => composeContracts(contract({ namespaces: ['core'] })),
    ]
    for (const bad of bads) expect(code(bad)).toBe('kernel.contract_invalid')
  })
})
