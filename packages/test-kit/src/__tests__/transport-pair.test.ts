import { describe, expect, test } from 'bun:test'
import type { RpcMessage } from '@poietica/rpc'
import { transportPair } from '../transport-pair'

const notification = (method: string, params: unknown): RpcMessage => ({ jsonrpc: '2.0', method, params })

describe('transportPair', () => {
  test('消息异步到达', async () => {
    const [a, b] = transportPair()
    const received: RpcMessage[] = []
    b.onMessage((m) => received.push(m))
    a.send(notification('x.y', {}))
    expect(received.length).toBe(0)
    await Promise.resolve()
    expect(received.length).toBe(1)
  })

  test('undefined 字段在 JSON 往返后消失', async () => {
    const [a, b] = transportPair()
    const received: RpcMessage[] = []
    b.onMessage((m) => received.push(m))
    a.send(notification('x.y', { a: undefined, b: 1 }))
    await Promise.resolve()
    expect(received[0]).toEqual({ jsonrpc: '2.0', method: 'x.y', params: { b: 1 } })
    expect('a' in (received[0] as { params: Record<string, unknown> }).params).toBe(false)
  })

  test('一端 close → 两端各触发一次 onClose；之后 send 无效果', async () => {
    const [a, b] = transportPair()
    const left: string[] = []
    const right: string[] = []
    a.onClose((r) => left.push(r))
    b.onClose((r) => right.push(r))
    const received: RpcMessage[] = []
    b.onMessage((m) => received.push(m))
    a.close('bye')
    a.close('again')
    expect(left).toEqual(['bye'])
    expect(right).toEqual(['bye'])
    a.send(notification('x.y', {}))
    await Promise.resolve()
    expect(received.length).toBe(0)
  })
})
