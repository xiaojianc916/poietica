import { describe, expect, test } from 'bun:test'
import { noopLogger } from '@poietica/foundation'
import { encodeFrame, FRAME_PREFIX, FrameDecoder } from '../frame'
import type { RpcMessage } from '../messages'
import { RpcPeer } from '../peer'
import { createChildProcessTransport } from '../stdio'

function collector(requirePrefix: boolean) {
  const messages: RpcMessage[] = []
  const strays: string[] = []
  const decoder = new FrameDecoder(
    requirePrefix,
    (m) => messages.push(m),
    (t) => strays.push(t),
  )
  return { decoder, messages, strays }
}

const message = (id: number): RpcMessage => ({ jsonrpc: '2.0', id, method: 'a.b', params: {} })

describe('FrameDecoder', () => {
  test('一条消息被拆成 3 个 chunk 推入 → 解出 1 条', () => {
    const { decoder, messages } = collector(true)
    const frame = encodeFrame(message(1))
    decoder.push(frame.slice(0, 5))
    decoder.push(frame.slice(5, 11))
    decoder.push(frame.slice(11))
    expect(messages.length).toBe(1)
    expect(messages[0]).toEqual(message(1))
  })

  test('两条消息在同一个 chunk → 解出 2 条', () => {
    const { decoder, messages } = collector(true)
    decoder.push(encodeFrame(message(1)) + encodeFrame(message(2)))
    expect(messages.length).toBe(2)
  })

  test('\\r\\n 结尾也能解出', () => {
    const { decoder, messages } = collector(true)
    decoder.push(`${FRAME_PREFIX}${JSON.stringify(message(3))}\r\n`)
    expect(messages.length).toBe(1)
  })

  test('requirePrefix：无前缀的行进 onStray；前缀之前的内容也进 onStray', () => {
    const { decoder, messages, strays } = collector(true)
    decoder.push('hello from native\n')
    expect(messages.length).toBe(0)
    expect(strays).toEqual(['hello from native'])
    decoder.push(`abc${FRAME_PREFIX}${JSON.stringify(message(4))}\n`)
    expect(messages.length).toBe(1)
    expect(strays[1]).toBe('abc')
  })

  test('坏 JSON → onStray 以 [bad frame] 开头', () => {
    const { decoder, strays } = collector(true)
    decoder.push(`${FRAME_PREFIX}{oops\n`)
    expect(strays[0]?.startsWith('[bad frame]')).toBe(true)
  })

  test('非 jsonrpc 对象 → [not jsonrpc]', () => {
    const { decoder, strays } = collector(true)
    decoder.push(`${FRAME_PREFIX}{"a":1}\n`)
    expect(strays[0]?.startsWith('[not jsonrpc]')).toBe(true)
  })

  test('空行被忽略', () => {
    const { decoder, messages, strays } = collector(true)
    decoder.push('\n\n   \n')
    expect(messages.length).toBe(0)
    expect(strays.length).toBe(0)
  })
})

describe('坏帧的协议行为（05 §4）', () => {
  test('坏帧不回复、不毒化帧流：stray 带 [bad frame]，前后帧照常交付，且对端零回复', async () => {
    const writes: string[] = []
    const strays: string[] = []
    const notifications: string[] = []
    const dataListeners: Array<(chunk: string) => void> = []
    const child = {
      stdin: {
        write: (chunk: string): boolean => {
          writes.push(chunk)
          return true
        },
        end: (): void => undefined,
        on: (): void => undefined,
      },
      stdout: {
        setEncoding: (): void => undefined,
        on: (event: string, listener: (chunk: string) => void): void => {
          if (event === 'data') dataListeners.push(listener)
        },
      },
      once: (): void => undefined,
    }
    const transport = createChildProcessTransport(child as never, { onStray: (t) => strays.push(t) })
    const peer = new RpcPeer({
      name: 'frame-test',
      transport,
      logger: noopLogger,
      onNotification: (method) => notifications.push(method),
      onRequest: async () => 'ok',
    })
    const push = (chunk: string): void => {
      for (const listener of dataListeners) listener(chunk)
    }

    push(encodeFrame({ jsonrpc: '2.0', method: 'demo.before', params: {} }))
    push(`${FRAME_PREFIX}oops\n`)
    push(encodeFrame({ jsonrpc: '2.0', method: 'demo.after', params: {} }))

    expect(strays).toHaveLength(1)
    expect(strays[0]?.startsWith('[bad frame]')).toBe(true)
    expect(notifications).toEqual(['demo.before', 'demo.after'])
    /* 两条通知与一条坏帧都不产生任何回复。 */
    expect(writes).toEqual([])

    /* 坏帧之后的请求照常得到回复，且回复里没有 -32700。 */
    push(encodeFrame({ jsonrpc: '2.0', id: 7, method: 'demo.call', params: {} }))
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    expect(writes).toHaveLength(1)
    expect(JSON.parse(writes[0] ?? '')).toMatchObject({ id: 7, result: 'ok' })
    expect(writes.join('')).not.toContain('32700')
    peer.dispose()
  })
})
