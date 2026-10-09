import { describe, expect, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { RpcMessage } from '../messages'
import { createChildProcessTransport, createStdioTransport } from '../stdio'

const message = (method: string): RpcMessage => ({ jsonrpc: '2.0', method, params: {} })

describe('createStdioTransport（Core 侧）', () => {
  test('收到一行 JSON → onMessage', async () => {
    const input = new PassThrough()
    const frames: string[] = []
    const received: RpcMessage[] = []
    const transport = createStdioTransport({
      input,
      writeFrame: (f) => frames.push(f),
      onStray: () => {},
    })
    transport.onMessage((m) => received.push(m))
    input.write(`${JSON.stringify(message('a.b'))}\n`)
    await Bun.sleep(1)
    expect(received).toEqual([message('a.b')])
  })

  test('send → writeFrame 收到 \\x1e{…}\\n', () => {
    const input = new PassThrough()
    const frames: string[] = []
    const transport = createStdioTransport({ input, writeFrame: (f) => frames.push(f), onStray: () => {} })
    transport.send(message('a.b'))
    expect(frames[0]?.startsWith('\x1e')).toBe(true)
    expect(frames[0]?.endsWith('\n')).toBe(true)
    expect(JSON.parse(frames[0]!.slice(1))).toEqual(message('a.b'))
  })

  test('stdin end() → onClose("stdin closed")', async () => {
    const input = new PassThrough()
    const reasons: string[] = []
    const transport = createStdioTransport({ input, writeFrame: () => {}, onStray: () => {} })
    transport.onClose((r) => reasons.push(r))
    input.end()
    await Bun.sleep(1)
    expect(reasons).toEqual(['stdin closed'])
  })
})

describe('createChildProcessTransport（Host 侧）', () => {
  function fakeChild() {
    const stdin = new PassThrough()
    const stdout = new PassThrough()
    const written: string[] = []
    const original = stdin.write.bind(stdin)
    stdin.write = ((chunk: string) => {
      written.push(chunk)
      return original(chunk)
    }) as typeof stdin.write
    const child = Object.assign(new EventEmitter(), { stdin, stdout })
    return { child, written, stdout }
  }

  test('send 写入 stdin 的是不带前缀的行', () => {
    const { child, written } = fakeChild()
    const transport = createChildProcessTransport(child, { onStray: () => {} })
    transport.send(message('a.b'))
    expect(written[0]?.startsWith('\x1e')).toBe(false)
    expect(JSON.parse(written[0]!.trim())).toEqual(message('a.b'))
  })

  test('stdout 推入杂散文本进 onStray；带前缀的帧正常解出', async () => {
    const { child, stdout } = fakeChild()
    const strays: string[] = []
    const received: RpcMessage[] = []
    const transport = createChildProcessTransport(child, { onStray: (t) => strays.push(t) })
    transport.onMessage((m) => received.push(m))
    stdout.write('noise from native\n')
    stdout.write(`\x1e${JSON.stringify(message('a.b'))}\n`)
    await Bun.sleep(1)
    expect(strays).toEqual(['noise from native'])
    expect(received).toEqual([message('a.b')])
  })

  test('emit exit → onClose("exit 0")；close 结束 stdin；stdin error 不抛出', async () => {
    const { child, stdout } = fakeChild()
    const reasons: string[] = []
    const transport = createChildProcessTransport(child, { onStray: () => {} })
    transport.onClose((r) => reasons.push(r))
    let ended = false
    child.stdin.on('finish', () => {
      ended = true
    })
    expect(() => child.stdin.emit('error', new Error('EPIPE'))).not.toThrow()
    transport.close('bye')
    await Bun.sleep(1)
    expect(ended).toBe(true)
    expect(reasons).toEqual(['bye'])
    child.emit('exit', 0, null)
    expect(reasons).toEqual(['bye'])
    stdout.end()
  })

  test('stdio 非 pipe 时抛错', () => {
    expect(() =>
      createChildProcessTransport(Object.assign(new EventEmitter(), { stdin: null, stdout: null }), {
        onStray: () => {},
      }),
    ).toThrow('stdio')
  })
})
