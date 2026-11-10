import { describe, expect, test } from 'bun:test'
import path from 'node:path'
import { createTestLogger } from '@poietica/test-kit'
import { RuntimeProcess } from '../index'
import { type ManagedRuntime, RuntimePool } from '../pool'

class FakeRuntime implements ManagedRuntime {
  state: 'idle' | 'starting' | 'ready' | 'failed' | 'stopped' = 'idle'
  starts = 0
  stops = 0
  constructor(readonly key: string) {}
  get status() {
    return { state: this.state, error: null }
  }
  async start() {
    this.starts += 1
    this.state = 'ready'
  }
  async stop() {
    this.stops += 1
    this.state = 'stopped'
  }
  async restart() {
    await this.stop()
    await this.start()
  }
}

describe('RuntimePool', () => {
  test('按 key 复用；失败后 acquire 会重启；release 停掉', async () => {
    const created: FakeRuntime[] = []
    const pool = new RuntimePool<FakeRuntime>({
      maxWorkers: 2,
      create: (key) => {
        const worker = new FakeRuntime(key)
        created.push(worker)
        return worker
      },
    })
    const a = await pool.acquire('ws-a')
    expect(await pool.acquire('ws-a')).toBe(a)
    expect(a.starts).toBe(1)
    a.state = 'failed'
    await pool.acquire('ws-a')
    expect(a.starts).toBe(2)
    expect(a.stops).toBe(1)

    await pool.acquire('ws-b')
    expect(created).toHaveLength(2)
    await expect(pool.acquire('ws-c')).rejects.toThrow('上限')
    await pool.release('ws-a')
    expect(a.stops).toBe(2)
    expect(pool.size).toBe(1)
    await pool.release('ws-b')
    expect(pool.size).toBe(0)
  })
})

describe('RuntimePool with real workers', () => {
  test('真实 Worker 被杀后按 key 重建', async () => {
    const worker = path.join(import.meta.dir, 'fixtures', 'worker.ts')
    const pool = new RuntimePool<RuntimeProcess>({
      maxWorkers: 2,
      create: () =>
        new RuntimeProcess({
          launch: { command: process.execPath, args: [worker] },
          logger: createTestLogger(),
          readyTimeoutMs: 5_000,
        }),
    })
    const a = await pool.acquire('ws-a')
    const b = await pool.acquire('ws-b')
    await a.kill()
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(a.status.state).toBe('failed')
    const again = await pool.acquire('ws-a')
    expect(again).toBe(a)
    expect(again.status.state).toBe('ready')
    expect(await again.request('session.ping', {})).toEqual({ ok: true })
    expect(await b.request('session.ping', {})).toEqual({ ok: true })
    await pool.stopAll()
  })
})
