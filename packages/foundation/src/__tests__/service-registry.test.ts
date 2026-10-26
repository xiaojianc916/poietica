import { describe, expect, test } from 'bun:test'
import { AppError } from '../errors'
import { createServiceRegistry, KERNEL_OWNER } from '../service-registry'
import { defineServiceToken } from '../service-token'

const code = (e: unknown): string => (e instanceof AppError ? e.code : 'not-app-error')

describe('createServiceRegistry', () => {
  test('提供自己的令牌后，声明了依赖的模块能取到同一对象', () => {
    const registry = createServiceRegistry()
    const token = defineServiceToken<{ n: number }>('conversation', 'ConversationService')
    const impl = { n: 1 }
    registry.scoped('conversation', []).provide(token, impl)
    expect(registry.scoped('automations', ['conversation']).get(token)).toBe(impl)
  })

  test('提供别人的令牌 → kernel.service_access_denied', () => {
    const registry = createServiceRegistry()
    const token = defineServiceToken<number>('conversation', 'X')
    expect(code(catchOf(() => registry.scoped('usage', []).provide(token, 1)))).toBe('kernel.service_access_denied')
  })

  test('未在 dependsOn 声明就 get / tryGet → kernel.service_access_denied', () => {
    const registry = createServiceRegistry()
    const token = defineServiceToken<number>('conversation', 'X')
    registry.scoped('conversation', []).provide(token, 1)
    const usage = registry.scoped('usage', [])
    expect(code(catchOf(() => usage.get(token)))).toBe('kernel.service_access_denied')
    expect(code(catchOf(() => usage.tryGet(token)))).toBe('kernel.service_access_denied')
  })

  test('声明了但提供方未 provide：get 抛 not_found，tryGet 返回 undefined', () => {
    const registry = createServiceRegistry()
    const token = defineServiceToken<number>('conversation', 'X')
    const usage = registry.scoped('usage', ['conversation'])
    expect(code(catchOf(() => usage.get(token)))).toBe('kernel.not_found')
    expect(usage.tryGet(token)).toBeUndefined()
  })

  test('同名令牌各提供一次 → 第二次 kernel.conflict', () => {
    const registry = createServiceRegistry()
    const first = defineServiceToken<number>('a', 'Same')
    const second = defineServiceToken<number>('a', 'Same')
    registry.scoped('a', []).provide(first, 1)
    expect(code(catchOf(() => registry.scoped('a', []).provide(second, 2)))).toBe('kernel.conflict')
  })

  test('KERNEL_OWNER 的令牌任何模块都能 get，无需 dependsOn', () => {
    const registry = createServiceRegistry()
    const token = defineServiceToken<string>(KERNEL_OWNER, 'navigation')
    registry.kernelScope().provide(token, 'nav')
    expect(registry.scoped('anything', []).get(token)).toBe('nav')
  })
})

function catchOf(fn: () => void): unknown {
  try {
    fn()
  } catch (e) {
    return e
  }
  return undefined
}

describe('服务的生命周期', () => {
  test('撤销会移除服务，旧作用域与新取得的同名作用域都不能再使用', () => {
    const registry = createServiceRegistry()
    const token = defineServiceToken<number>('alpha', 'Value')
    const owner = registry.scoped('alpha', [])
    const consumer = registry.scoped('beta', ['alpha'])
    owner.provide(token, 1)
    registry.revoke('alpha')
    registry.revoke('alpha')
    expect(consumer.tryGet(token)).toBeUndefined()
    expect(code(catchOf(() => consumer.get(token)))).toBe('kernel.not_found')
    expect(code(catchOf(() => owner.provide(token, 2)))).toBe('kernel.service_access_denied')
    expect(code(catchOf(() => owner.tryGet(token)))).toBe('kernel.service_access_denied')
    expect(code(catchOf(() => registry.scoped('alpha', []).provide(token, 3)))).toBe('kernel.service_access_denied')
  })

  test('撤销一个模块不会撤销依赖方或其它模块的服务', () => {
    const registry = createServiceRegistry()
    const token = defineServiceToken<number>('beta', 'Value')
    registry.scoped('beta', ['alpha']).provide(token, 2)
    registry.revoke('alpha')
    expect(registry.scoped('gamma', ['beta']).get(token)).toBe(2)
  })
})
