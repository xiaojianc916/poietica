import { describe, expect, test } from 'bun:test'
import { defineContract, defineErrors, defineMethod, defineNotification } from '@poietica/contract-kit'
import { AppError, SystemErrorCode } from '@poietica/foundation'
import { Router, RpcPeer } from '@poietica/rpc'
import { createTestLogger, transportPair } from '@poietica/test-kit'
import { z } from 'zod'
import { createCoreRpcBinding } from '../rpc-binding'

const c = defineContract({
  id: 'alpha',
  namespaces: ['alpha'],
  methods: [
    defineMethod({
      name: 'alpha.echo',
      owner: 'core',
      params: z.object({ v: z.string() }),
      result: z.object({ v: z.string() }),
      description: 'echo',
    }),
    defineMethod({
      name: 'alpha.hostOnly',
      owner: 'host',
      params: z.object({}),
      result: z.object({}),
      description: 'host 的方法',
    }),
  ],
  notifications: [
    defineNotification({ name: 'alpha.ping', owner: 'core', params: z.object({ n: z.number() }), description: 'ping' }),
    defineNotification({ name: 'alpha.hostPing', owner: 'host', params: z.object({}), description: 'host 通知' }),
  ],
  errors: defineErrors('alpha', {}),
})

function deps(strict: boolean, onNotification?: (method: string, params: unknown) => void) {
  const router = new Router()
  const [a, b] = transportPair()
  const peer = new RpcPeer({ name: 'core', transport: a, logger: createTestLogger() })
  const other = new RpcPeer({ name: 'host', transport: b, logger: createTestLogger(), onNotification })
  return { router, peer, other, strict }
}

describe('createCoreRpcBinding', () => {
  test('handle 注册后可通过 Router 调用，参数已校验', async () => {
    const d = deps(true)
    const binding = createCoreRpcBinding(c, { moduleId: 'alpha', router: d.router, peer: () => d.peer, strict: true })
    binding.handle('alpha.echo', (p) => ({ v: p.v.toUpperCase() }))
    const out = await d.router.handle(
      'alpha.echo',
      { v: 'ab' },
      { id: 1, signal: new AbortController().signal, meta: undefined },
    )
    expect(out).toEqual({ v: 'AB' })
    d.peer.dispose()
    d.other.dispose()
  })

  test('handle 非本契约的 core 方法 → kernel.unhandled_method', () => {
    const d = deps(true)
    const binding = createCoreRpcBinding(c, { moduleId: 'alpha', router: d.router, peer: () => d.peer, strict: true })
    expect(() => binding.handle('alpha.hostOnly', () => ({}))).toThrow(AppError)
    try {
      binding.handle('alpha.hostOnly', () => ({}))
    } catch (e) {
      expect((e as AppError).code).toBe(SystemErrorCode.unhandledMethod)
    }
    d.peer.dispose()
    d.other.dispose()
  })

  test('emit 把通知发给对端', async () => {
    const seen: { method: string; params: unknown }[] = []
    const d = deps(true, (method, params) => seen.push({ method, params }))
    const binding = createCoreRpcBinding(c, { moduleId: 'alpha', router: d.router, peer: () => d.peer, strict: true })
    binding.emit('alpha.ping', { n: 5 })
    /* transportPair 经 queueMicrotask 投递：让出一次微任务再断言收到的是原样载荷。 */
    await Bun.sleep(1)
    expect(seen).toEqual([{ method: 'alpha.ping', params: { n: 5 } }])
    d.peer.dispose()
    d.other.dispose()
  })

  test('emit 非本契约的 core 通知 → kernel.unhandled_method', () => {
    const d = deps(true)
    const binding = createCoreRpcBinding(c, { moduleId: 'alpha', router: d.router, peer: () => d.peer, strict: true })
    try {
      binding.emit('alpha.hostPing', {})
    } catch (e) {
      expect((e as AppError).code).toBe(SystemErrorCode.unhandledMethod)
    }
    d.peer.dispose()
    d.other.dispose()
  })

  test('strict 下 emit 的参数不符合契约 → kernel.internal', () => {
    const d = deps(true)
    const binding = createCoreRpcBinding(c, { moduleId: 'alpha', router: d.router, peer: () => d.peer, strict: true })
    try {
      binding.emit('alpha.ping', { n: 'x' } as never)
    } catch (e) {
      expect((e as AppError).code).toBe(SystemErrorCode.internal)
    }
    d.peer.dispose()
    d.other.dispose()
  })

  test('strict 下 handle 的返回值不符合契约 → kernel.internal', async () => {
    const d = deps(true)
    const binding = createCoreRpcBinding(c, { moduleId: 'alpha', router: d.router, peer: () => d.peer, strict: true })
    binding.handle('alpha.echo', () => ({ v: 1 }) as never)
    await expect(
      d.router.handle('alpha.echo', { v: 'a' }, { id: 1, signal: new AbortController().signal, meta: undefined }),
    ).rejects.toThrow(/不符合契约/)
    d.peer.dispose()
    d.other.dispose()
  })

  test('非 strict 时不校验返回值与通知', async () => {
    const d = deps(false)
    const binding = createCoreRpcBinding(c, { moduleId: 'alpha', router: d.router, peer: () => d.peer, strict: false })
    binding.handle('alpha.echo', () => ({ v: 1 }) as never)
    binding.emit('alpha.ping', { n: 'x' } as never)
    const out = await d.router.handle(
      'alpha.echo',
      { v: 'a' },
      { id: 1, signal: new AbortController().signal, meta: undefined },
    )
    expect(out).toEqual({ v: 1 })
    d.peer.dispose()
    d.other.dispose()
  })
})
