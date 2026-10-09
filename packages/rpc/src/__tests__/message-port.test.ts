import { describe, expect, test } from 'bun:test'
import { createMessagePortTransport } from '../message-port'
import type { RpcMessage } from '../messages'

const message = (method: string): RpcMessage => ({ jsonrpc: '2.0', method, params: {} })

describe('createMessagePortTransport', () => {
  test('双向收发', async () => {
    const channel = new MessageChannel()
    const left = createMessagePortTransport(channel.port1)
    const right = createMessagePortTransport(channel.port2)
    const received: RpcMessage[] = []
    right.onMessage((m) => received.push(m))
    left.send(message('a.b'))
    await Bun.sleep(1)
    expect(received).toEqual([message('a.b')])
    left.close('done')
    right.close('done')
  })

  test('非 jsonrpc 消息被忽略', async () => {
    const channel = new MessageChannel()
    const left = createMessagePortTransport(channel.port1)
    const right = createMessagePortTransport(channel.port2)
    const received: RpcMessage[] = []
    right.onMessage((m) => received.push(m))
    channel.port1.postMessage({ hello: 'world' })
    channel.port1.postMessage('nope')
    await Bun.sleep(1)
    expect(received.length).toBe(0)
    left.close('done')
    right.close('done')
  })

  test('close 触发 onClose 一次、重复 close 无效果、关闭后 send 不抛错', () => {
    const channel = new MessageChannel()
    const left = createMessagePortTransport(channel.port1)
    const reasons: string[] = []
    left.onClose((r) => reasons.push(r))
    left.close('first')
    left.close('second')
    expect(reasons).toEqual(['first'])
    expect(() => left.send(message('a.b'))).not.toThrow()
    channel.port2.close()
  })

  test('关闭之后不再触发 onMessage；监听器抛错不影响其它监听器', async () => {
    const channel = new MessageChannel()
    const left = createMessagePortTransport(channel.port1)
    const seen: string[] = []
    const { spyOn } = await import('bun:test')
    const spy = spyOn(console, 'error').mockImplementation(() => {})
    left.onMessage(() => {
      throw new Error('boom')
    })
    left.onMessage(() => seen.push('second'))
    channel.port2.postMessage(message('a.b'))
    await Bun.sleep(1)
    expect(seen).toEqual(['second'])
    left.close('done')
    channel.port2.postMessage(message('c.d'))
    await Bun.sleep(1)
    expect(seen).toEqual(['second'])
    spy.mockRestore()
    channel.port2.close()
  })
})
