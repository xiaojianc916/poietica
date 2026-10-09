import { describe, expect, test } from 'bun:test'
import type { EngineSession, OpenSessionSpec } from '@poietica/engine'
import { createFakeEngine } from '@poietica/engine-testkit'
import { createTestLogger, fakeClock } from '@poietica/test-kit'
import { IDLE_TTL_MS, MAX_IDLE_SESSIONS, SessionPool, SWEEP_INTERVAL_MS } from '../session-pool'

function poolFor(opts: { clock: ReturnType<typeof fakeClock>; threads: string[] }) {
  const engine = createFakeEngine()
  engine.freezeTools()
  const opened: OpenSessionSpec[] = []
  const events: { threadId: string; type: string }[] = []
  const released: string[] = []
  const pool = new SessionPool({
    engine,
    clock: opts.clock,
    logger: createTestLogger(),
    describe: (threadId) => {
      const spec: OpenSessionSpec = {
        key: threadId,
        cwd: 'C:\\tmp',
        sessionFile: null,
        posture: 'auto-edit',
        model: null,
        thinking: null,
      }
      opened.push(spec)
      return spec
    },
    onOpened: () => undefined,
    onEvent: (threadId, e) => events.push({ threadId, type: e.type }),
    onReleased: (threadId) => released.push(threadId),
  })
  return { pool, engine, opened, released, events }
}

describe('CV-7 会话池：并发 acquire 只打开一次', () => {
  test('同一线程并发 acquire 拿到同一个会话，openSession 只调用一次', async () => {
    const clock = fakeClock()
    const { pool, engine } = poolFor({ clock, threads: ['t1'] })
    const [a, b, c] = await Promise.all([pool.acquire('t1'), pool.acquire('t1'), pool.acquire('t1')])
    expect(a).toBe(b)
    expect(b).toBe(c)
    expect(engine.opened.length).toBe(1)
    await pool.dispose()
  })

  test('打开失败后再次 acquire 会重新打开（失败的 promise 不留表）', async () => {
    const clock = fakeClock()
    const engine = createFakeEngine()
    engine.freezeTools()
    let calls = 0
    const original = engine.openSession.bind(engine)
    const broken = {
      ...engine,
      async openSession(spec: OpenSessionSpec): Promise<EngineSession> {
        calls += 1
        if (calls === 1) throw new Error('boom')
        return original(spec)
      },
    } as typeof engine
    const pool = new SessionPool({
      engine: broken,
      clock,
      logger: createTestLogger(),
      describe: (threadId) => ({
        key: threadId,
        cwd: 'C:\\tmp',
        sessionFile: null,
        posture: 'auto-edit',
        model: null,
        thinking: null,
      }),
      onOpened: () => undefined,
      onEvent: () => undefined,
      onReleased: () => undefined,
    })
    await expect(pool.acquire('t1')).rejects.toThrow('boom')
    const session = await pool.acquire('t1')
    expect(session).toBeDefined()
    expect(calls).toBe(2)
    await pool.dispose()
  })
})

describe('CV-8 会话池：空闲上限与 TTL', () => {
  test('7 个空闲会话 → 最久未用的 1 个被释放', async () => {
    const clock = fakeClock()
    const { pool, released } = poolFor({ clock, threads: [] })
    for (let i = 1; i <= MAX_IDLE_SESSIONS + 1; i++) {
      clock.advance(1)
      await pool.acquire(`t${i}`)
    }
    // acquire 第 7 个时（keep=t7），空闲的有 t1..t6 共 6 个，不超上限；
    // 再开一个才会挤掉最久未用的。
    clock.advance(1)
    await pool.acquire('t8')
    expect(released).toContain('t1')
    expect(released.length).toBeGreaterThan(0)
    await pool.dispose()
  })

  test('忙会话永不驱逐：第 7 个空闲会话进来时，忙的那个不动', async () => {
    const clock = fakeClock()
    const { pool, released } = poolFor({ clock, threads: [] })
    for (let i = 1; i <= MAX_IDLE_SESSIONS; i++) {
      clock.advance(1)
      await pool.acquire(`t${i}`)
    }
    // 让 t1 忙起来
    const busy = pool.peek('t1')!
    await busy.submit({ text: 'hi', images: [], files: [], skills: [], deliverAs: 'turn' })
    expect(busy.isBusy()).toBe(true)
    clock.advance(1)
    await pool.acquire('t9')
    expect(released).not.toContain('t1')
    await pool.dispose()
  })

  test('空闲 10 分钟（fakeClock）被释放；忙的不释放', async () => {
    const clock = fakeClock()
    const { pool, released } = poolFor({ clock, threads: [] })
    await pool.acquire('idle')
    await pool.acquire('busy')
    const busy = pool.peek('busy')!
    await busy.submit({ text: 'hi', images: [], files: [], skills: [], deliverAs: 'turn' })
    // 一次推进跨越 TTL 与一个 sweep 周期：advanceAsync 在每个定时器之后让出微任务，
    // 于是 sweep 里的 await release() 有机会跑完（advance 是同步的，Promise 链推不动）。
    await clock.advanceAsync(IDLE_TTL_MS + SWEEP_INTERVAL_MS + 1)
    await clock.advanceAsync(1)
    expect(released).toContain('idle')
    expect(released).not.toContain('busy')
    await pool.dispose()
  })
})
