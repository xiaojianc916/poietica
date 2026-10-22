import { afterEach, describe, expect, test } from 'bun:test'
import { type ChildProcess, spawn } from 'node:child_process'
import path from 'node:path'
import { type AppError, noopLogger } from '@poietica/foundation'
import { jsonValue, RawJson } from '../frame'
import { RpcPeer } from '../peer'
import { createChildProcessTransport } from '../stdio'
import type { Transport } from '../transport'

const fixturePath = path.join(import.meta.dir, 'fixtures', 'stdio-peer.ts')

interface Host {
  readonly peer: RpcPeer
  readonly transport: Transport
  readonly child: ChildProcess
  readonly strays: string[]
  readonly closes: string[]
  dispose(): void
}

function startHost(): Host {
  const child = spawn(process.execPath, [fixturePath], { stdio: ['pipe', 'pipe', 'pipe'] })
  const strays: string[] = []
  const closes: string[] = []
  const transport = createChildProcessTransport(child, { onStray: (t) => strays.push(t) })
  transport.onClose((reason) => closes.push(reason))
  const peer = new RpcPeer({
    name: 'interop-host',
    transport,
    logger: noopLogger,
    onRequest: async (method) => (method === 'host.ping' ? { pong: true } : {}),
  })
  return {
    peer,
    transport,
    child,
    strays,
    closes,
    dispose() {
      peer.dispose()
      if (child.exitCode === null) child.kill()
    },
  }
}

const hosts: Host[] = []
const makeHost = (): Host => {
  const host = startHost()
  hosts.push(host)
  return host
}

afterEach(() => {
  for (const host of hosts.splice(0)) {
    host.dispose()
    if (host.child.exitCode === null) host.child.kill()
  }
})

describe('stdio 子进程互通', () => {
  test('IO-1 echo 原样返回（含非 ASCII）；Host 侧拿到的是未解析的 RawJson', async () => {
    const host = makeHost()
    const raw = await host.peer.request('echo', { a: 1, s: '中文' })
    expect(raw).toBeInstanceOf(RawJson)
    expect((raw as RawJson).text).toBe(JSON.stringify({ a: 1, s: '中文' }))
    expect(jsonValue(raw)).toEqual({ a: 1, s: '中文' })
  })

  test('IO-2 杂散输出不破坏帧', async () => {
    const host = makeHost()
    expect(jsonValue(await host.peer.request('noise', {}))).toEqual({ ok: true })
    expect(jsonValue(await host.peer.request('echo', { b: 2 }))).toEqual({ b: 2 })
    expect(host.strays.some((t) => t.includes('杂散输出'))).toBe(true)
    expect(host.strays.some((t) => t.includes('半行杂散'))).toBe(true)
  })

  test('IO-3 超时取消：kernel.timeout，之后仍可用', async () => {
    const host = makeHost()
    const error = await host.peer.request('slow', {}, { timeoutMs: 200 }).catch((e: unknown) => e)
    expect((error as AppError).code).toBe('kernel.timeout')
    expect(jsonValue(await host.peer.request('echo', { ok: 1 }))).toEqual({ ok: 1 })
  })

  test('IO-4 子进程反向请求 Host', async () => {
    const host = makeHost()
    expect(jsonValue(await host.peer.request('askHost', {}))).toEqual({ pong: true })
  })

  test('IO-5 并发 50 个请求各自对应', async () => {
    const host = makeHost()
    const results = await Promise.all(
      Array.from({ length: 50 }, async (_, i) => jsonValue(await host.peer.request('echo', { i })) as { i: number }),
    )
    expect(results.map((r) => r.i)).toEqual(Array.from({ length: 50 }, (_, i) => i))
  })

  test('IO-6 子进程退出 → onClose exit 7，挂起请求以 core_unavailable 失败', async () => {
    const host = makeHost()
    const pending = host.peer.request('slow', {}, { timeoutMs: 0 }).then(
      () => undefined,
      (e: unknown) => e,
    )
    await host.peer.request('exit', {})
    const error = await pending
    expect((error as AppError).code).toBe('kernel.core_unavailable')
    expect(host.closes).toContain('exit 7')
  })

  test('IO-7 Host 关闭传输 → 子进程读到 EOF 后以 0 退出', async () => {
    const host = makeHost()
    const exited = new Promise<number | null>((resolve) => host.child.once('exit', (code) => resolve(code)))
    host.peer.notify('whatever', {})
    await Bun.sleep(150)
    host.transport.close('bye')
    expect(await exited).toBe(0)
  })
})
