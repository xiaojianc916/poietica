import { describe, expect, test } from 'bun:test'
import { defineContract, defineMethod, defineNotification } from '@poietica/contract-kit'
import { z } from 'zod'
import type { CallOptions, RpcChannel } from '../typed-client'
import { createTypedClient } from '../typed-client'

const contract = defineContract({
  id: 'demo',
  namespaces: ['demo'],
  methods: [
    defineMethod({
      name: 'demo.get',
      owner: 'core',
      params: z.object({ id: z.string() }),
      result: z.object({ id: z.string(), n: z.number() }),
      timeoutMs: 1234,
      description: '取一个',
    }),
  ],
  notifications: [
    defineNotification({
      name: 'demo.changed',
      owner: 'core',
      params: z.object({ n: z.number() }),
      description: '变了',
    }),
  ],
  errors: { __messages: Object.freeze({}) },
})

function channelOf(reply: (method: string, params: unknown, opts: CallOptions & { timeoutMs: number }) => unknown) {
  const calls: Array<{ method: string; params: unknown; timeoutMs: number }> = []
  const listeners = new Map<string, (params: unknown) => void>()
  const channel: RpcChannel = {
    async request(method, params, opts) {
      calls.push({ method, params, timeoutMs: opts.timeoutMs })
      return reply(method, params, opts)
    },
    subscribe(notification, listener) {
      listeners.set(notification, listener)
      return { dispose: () => listeners.delete(notification) }
    },
  }
  return { channel, calls, listeners }
}

describe('createTypedClient', () => {
  test('timeoutMs 默认取契约里的值，调用方可覆盖', async () => {
    const { channel, calls } = channelOf(() => ({ id: 'a', n: 1 }))
    const client = createTypedClient(contract, channel, { validateResults: true })
    await client.call('demo.get', { id: 'a' })
    expect(calls[0]?.timeoutMs).toBe(1234)
    await client.call('demo.get', { id: 'a' }, { timeoutMs: 5 })
    expect(calls[1]?.timeoutMs).toBe(5)
  })

  test('validateResults 为 true 时错误的结果抛 zod 错误；false 时原样返回', async () => {
    const { channel } = channelOf(() => ({ nope: true }))
    const strict = createTypedClient(contract, channel, { validateResults: true })
    await expect(strict.call('demo.get', { id: 'a' })).rejects.toThrow()
    // validateResults=false 时结果原样透传，所以用 unknown 视图绕开声明类型
    const loose = createTypedClient(contract, channel, { validateResults: false }) as unknown as {
      call(name: 'demo.get', params: { id: string }): Promise<unknown>
    }
    expect(await loose.call('demo.get', { id: 'a' })).toEqual({ nope: true })
  })

  test('on 收到解析后的参数', () => {
    const { channel, listeners } = channelOf(() => ({}))
    const client = createTypedClient(contract, channel, { validateResults: true })
    const seen: number[] = []
    client.on('demo.changed', (params) => seen.push(params.n))
    listeners.get('demo.changed')?.({ n: 7 })
    expect(seen).toEqual([7])
  })
})
