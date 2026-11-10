import { describe, expect, test } from 'bun:test'
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { arpMethods } from '@poietica/runtime-protocol'
import { createTestLogger } from '@poietica/test-kit'
import { RuntimeProcess } from '../index'

const worker = path.join(import.meta.dir, 'fixtures', 'worker.ts')

describe('RuntimeProcess', () => {
  test('Worker 意外退出被标成 failed', async () => {
    const runtime = new RuntimeProcess({
      launch: {
        command: process.execPath,
        args: [worker],
        env: { RUNTIME_FIXTURE_EXIT_MS: '120' },
      },
      logger: createTestLogger(),
      readyTimeoutMs: 5_000,
    })
    await runtime.start()
    expect(runtime.status.state).toBe('ready')
    await new Promise((resolve) => setTimeout(resolve, 250))
    expect(runtime.status.state).toBe('failed')
    expect(runtime.status.error).toContain('Worker 退出')
    await runtime.stop()
  })

  test('一个 Worker 被杀不影响另一个 Worker', async () => {
    const make = () =>
      new RuntimeProcess({
        launch: { command: process.execPath, args: [worker] },
        logger: createTestLogger(),
        readyTimeoutMs: 5_000,
      })
    const a = make()
    const b = make()
    await a.start()
    await b.start()
    await a.kill()
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(a.status.state).toBe('failed')
    expect(await b.request('session.ping', {})).toEqual({ ok: true })
    expect(b.status.state).toBe('ready')
    await b.stop()
  })

  test('意外退出后按退避自动重启', async () => {
    const flag = path.join(import.meta.dir, 'fixtures', `exit-${Date.now()}.flag`)
    writeFileSync(flag, '1')
    const runtime = new RuntimeProcess({
      launch: {
        command: process.execPath,
        args: [worker],
        env: { RUNTIME_FIXTURE_EXIT_ONCE: flag },
      },
      logger: createTestLogger(),
      readyTimeoutMs: 5_000,
      autoRestart: true,
      backoffMs: [20],
    })
    await runtime.start()
    for (let i = 0; i < 100 && runtime.status.attempt === 0; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    for (let i = 0; i < 100 && runtime.status.state !== 'ready'; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    expect(runtime.status.state).toBe('ready')
    expect(runtime.status.attempt).toBe(1)
    await runtime.stop()
  })

  test('心跳超时把卡死的 Worker 标成 failed', async () => {
    const runtime = new RuntimeProcess({
      launch: {
        command: process.execPath,
        args: [worker],
        env: { RUNTIME_FIXTURE_HANG_MS: '1200' },
      },
      logger: createTestLogger(),
      readyTimeoutMs: 5_000,
      heartbeatMs: 50,
      heartbeatTimeoutMs: 30,
    })
    await runtime.start()
    await new Promise((resolve) => setTimeout(resolve, 600))
    expect(runtime.status.state).toBe('failed')
    expect(runtime.status.error).toBeString()
    await runtime.stop()
  })

  test('起进程、ARP 握手、注入方法、关停', async () => {
    const runtime = new RuntimeProcess({
      launch: { command: process.execPath, args: [worker] },
      logger: createTestLogger(),
      readyTimeoutMs: 5_000,
    })
    await runtime.start()
    expect(runtime.status.state).toBe('ready')
    expect(await runtime.request('session.ping', {})).toEqual({ ok: true })
    expect(await runtime.request(arpMethods.ping, {})).toMatchObject({ at: expect.any(String) })
    await runtime.stop()
    expect(runtime.status.state).toBe('stopped')
  })
})
