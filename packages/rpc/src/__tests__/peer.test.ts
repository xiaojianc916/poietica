import { describe, expect, test } from 'bun:test'
import { AppError, type Logger, noopLogger } from '@poietica/foundation'
import { transportPair } from '@poietica/test-kit'
import { CANCEL_METHOD, type RpcMessage } from '../messages'
import { RpcPeer } from '../peer'
import type { Transport } from '../transport'

/** 记录本端发出（以及经 transportPair 发往对端）的消息，供断言 $/cancelRequest 使用 */
function recordingPair(): { a: Transport; b: Transport; sentA: RpcMessage[]; sentB: RpcMessage[] } {
  const [rawA, rawB] = transportPair()
  const sentA: RpcMessage[] = []
  const sentB: RpcMessage[] = []
  const tap = (transport: Transport, sink: RpcMessage[]): Transport => ({
    send: (message) => {
      sink.push(JSON.parse(JSON.stringify(message)) as RpcMessage)
      transport.send(message)
    },
    onMessage: (listener) => transport.onMessage(listener),
    onClose: (listener) => transport.onClose(listener),
    close: (reason) => transport.close(reason),
  })
  return { a: tap(rawA, sentA), b: tap(rawB, sentB), sentA, sentB }
}

const pair = recordingPair

function recordingLogger(): { logger: Logger; errors: string[] } {
  const errors: string[] = []
  return {
    errors,
    logger: {
      ...noopLogger,
      error: (msg: string) => {
        errors.push(msg)
      },
      child: () => noopLogger,
    } as Logger,
  }
}

describe('RpcPeer', () => {
  test('请求 / 应答', async () => {
    const { a, b } = pair()
    const server = new RpcPeer({ name: 'b', transport: b, logger: noopLogger, onRequest: async () => ({ ok: 1 }) })
    const client = new RpcPeer({ name: 'a', transport: a, logger: noopLogger })
    expect(await client.request('x.y', {})).toEqual({ ok: 1 })
    client.dispose()
    server.dispose()
  })

  test('handler 抛 AppError → 调用方收到同样的 code、message、data', async () => {
    const { a, b } = pair()
    const server = new RpcPeer({
      name: 'b',
      transport: b,
      logger: noopLogger,
      onRequest: () => {
        throw new AppError('x.y', 'm', { a: 1 })
      },
    })
    const client = new RpcPeer({ name: 'a', transport: a, logger: noopLogger })
    const error = await client.request('x.y', {}).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(AppError)
    expect((error as AppError).code).toBe('x.y')
    expect((error as AppError).message).toBe('m')
    expect((error as AppError).data).toEqual({ a: 1 })
    client.dispose()
    server.dispose()
  })

  test('未提供 onRequest → kernel.method_not_found', async () => {
    const { a, b } = pair()
    const server = new RpcPeer({ name: 'b', transport: b, logger: noopLogger })
    const client = new RpcPeer({ name: 'a', transport: a, logger: noopLogger })
    const error = await client.request('x.y', {}).catch((e: unknown) => e)
    expect((error as AppError).code).toBe('kernel.method_not_found')
    client.dispose()
    server.dispose()
  })

  test('handler 返回 undefined → 调用方得到 null', async () => {
    const { a, b } = pair()
    const server = new RpcPeer({ name: 'b', transport: b, logger: noopLogger, onRequest: async () => undefined })
    const client = new RpcPeer({ name: 'a', transport: a, logger: noopLogger })
    expect(await client.request('x.y', {})).toBeNull()
    client.dispose()
    server.dispose()
  })

  test('超时 → kernel.timeout，对端收到 $/cancelRequest 且 handler 的 signal.aborted 为 true', async () => {
    const { a, b, sentA } = pair()
    let aborted = false
    let seen = false
    const server = new RpcPeer({
      name: 'b',
      transport: b,
      logger: noopLogger,
      onRequest: (_method, _params, ctx) =>
        new Promise((resolve) => {
          seen = true
          ctx.signal.addEventListener('abort', () => {
            aborted = true
            resolve(null)
          })
        }),
    })
    const client = new RpcPeer({ name: 'a', transport: a, logger: noopLogger })
    const error = await client.request('slow.method', {}, { timeoutMs: 20 }).catch((e: unknown) => e)
    expect((error as AppError).code).toBe('kernel.timeout')
    await Bun.sleep(20)
    expect(seen).toBe(true)
    expect(aborted).toBe(true)
    // 取消通知由调用方发出，所以记在 sentA 上
    expect(sentA.some((m) => 'method' in m && m.method === CANCEL_METHOD)).toBe(true)
    client.dispose()
    server.dispose()
  })

  test('调用方 abort → kernel.cancelled', async () => {
    const { a, b } = pair()
    const server = new RpcPeer({
      name: 'b',
      transport: b,
      logger: noopLogger,
      onRequest: () => new Promise(() => {}),
    })
    const client = new RpcPeer({ name: 'a', transport: a, logger: noopLogger })
    const ac = new AbortController()
    const pending = client.request('slow.method', {}, { signal: ac.signal })
    ac.abort()
    const error = await pending.catch((e: unknown) => e)
    expect((error as AppError).code).toBe('kernel.cancelled')
    client.dispose()
    server.dispose()
  })

  test('传输关闭 → 挂起请求以 kernel.core_unavailable 失败；之后 request 立即失败、notify 无效果', async () => {
    const { a, b } = pair()
    const server = new RpcPeer({
      name: 'b',
      transport: b,
      logger: noopLogger,
      onRequest: () => new Promise(() => {}),
    })
    const client = new RpcPeer({ name: 'a', transport: a, logger: noopLogger })
    const pending = client.request('slow.method', {})
    server.dispose()
    a.close('gone')
    const error = await pending.catch((e: unknown) => e)
    expect((error as AppError).code).toBe('kernel.core_unavailable')
    const immediate = await client.request('x.y', {}).catch((e: unknown) => e)
    expect((immediate as AppError).code).toBe('kernel.core_unavailable')
    expect(() => client.notify('x.y', {})).not.toThrow()
  })

  test('通知 handler 抛错 → 记一条 error 日志，后续消息仍正常', async () => {
    const { a, b } = pair()
    const { logger, errors } = recordingLogger()
    const received: string[] = []
    const server = new RpcPeer({
      name: 'b',
      transport: b,
      logger,
      onRequest: async () => 'ok',
      onNotification: (method) => {
        received.push(method)
        throw new Error('boom')
      },
    })
    const client = new RpcPeer({ name: 'a', transport: a, logger: noopLogger })
    client.notify('n.one', {})
    await Bun.sleep(1)
    expect(errors.length).toBe(1)
    expect(await client.request('x.y', {})).toBe('ok')
    client.notify('n.two', {})
    await Bun.sleep(1)
    expect(received).toEqual(['n.one', 'n.two'])
    client.dispose()
    server.dispose()
  })

  test('meta 原样到达对端的 ctx.meta', async () => {
    const { a, b } = pair()
    let seen: unknown
    const server = new RpcPeer({
      name: 'b',
      transport: b,
      logger: noopLogger,
      onRequest: async (_m, _p, ctx) => {
        seen = ctx.meta
        return null
      },
    })
    const client = new RpcPeer({ name: 'a', transport: a, logger: noopLogger })
    await client.request('x.y', {}, { meta: { traceId: 't1', origin: 'ui' } })
    expect(seen).toEqual({ traceId: 't1', origin: 'ui' })
    client.dispose()
    server.dispose()
  })
})
