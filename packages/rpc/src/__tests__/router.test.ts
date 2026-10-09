import { describe, expect, test } from 'bun:test'
import { defineContract, defineMethod } from '@poietica/contract-kit'
import { AppError, type AppError as AppErrorType } from '@poietica/foundation'
import { z } from 'zod'
import type { InboundContext } from '../peer'
import { Router } from '../router'

const contract = defineContract({
  id: 'demo',
  namespaces: ['demo'],
  methods: [
    defineMethod({
      name: 'demo.echo',
      owner: 'core',
      params: z.object({ text: z.string(), count: z.number().int().default(3) }),
      result: z.object({ text: z.string(), count: z.number() }),
      description: '回显',
    }),
  ],
  notifications: [],
  errors: { __messages: Object.freeze({}) },
})

const ctx: InboundContext = { id: 1, signal: new AbortController().signal, meta: undefined }
const def = contract.methods[0]

describe('Router', () => {
  test('参数校验失败 → kernel.invalid_params，data.issues 是数组', async () => {
    const router = new Router()
    router.register(def, () => ({ text: 'x', count: 1 }))
    const error = await router.handle('demo.echo', { text: 42 }, ctx).catch((e: unknown) => e)
    expect((error as AppErrorType).code).toBe('kernel.invalid_params')
    expect(Array.isArray((error as AppErrorType).data?.issues)).toBe(true)
  })

  test('重复注册 → kernel.conflict', () => {
    const router = new Router()
    router.register(def, () => ({ text: 'x', count: 1 }))
    expect(() => router.register(def, () => ({ text: 'y', count: 2 }))).toThrow(AppError)
  })

  test('dispose 后 has() 为 false', () => {
    const router = new Router()
    const sub = router.register(def, () => ({ text: 'x', count: 1 }))
    expect(router.has('demo.echo')).toBe(true)
    sub.dispose()
    expect(router.has('demo.echo')).toBe(false)
  })

  test('未注册 → kernel.method_not_found', async () => {
    const router = new Router()
    const error = await router.handle('demo.echo', {}, ctx).catch((e: unknown) => e)
    expect((error as AppErrorType).code).toBe('kernel.method_not_found')
  })

  test('handler 收到的是 zod 输出（带 .default() 的字段被补齐）', async () => {
    const router = new Router()
    let seen: unknown
    router.register(def, (params) => {
      seen = params
      return { text: 'ok', count: 1 }
    })
    await router.handle('demo.echo', { text: 'hi' }, ctx)
    expect(seen).toEqual({ text: 'hi', count: 3 })
  })
})
