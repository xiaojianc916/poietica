import { describe, expect, test } from 'bun:test'
import { AppError } from '@poietica/foundation'
import { rpcHarness } from '../rpc-harness'

describe('rpcHarness', () => {
  test('client 请求 server 得到应答；server 的通知被 client 收到；dispose 后请求失败', async () => {
    const seen: string[] = []
    const harness = rpcHarness({
      serverRequests: async (method) => ({ ok: method }),
      clientNotifications: (method) => seen.push(method),
    })
    expect(await harness.client.request('a.b', {})).toEqual({ ok: 'a.b' })
    harness.server.notify('c.d', {})
    await Promise.resolve()
    expect(seen).toEqual(['c.d'])
    harness.dispose()
    const error = await harness.client.request('a.b', {}).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(AppError)
    expect((error as AppError).code).toBe('kernel.core_unavailable')
  })
})
