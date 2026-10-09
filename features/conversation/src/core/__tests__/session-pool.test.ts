import { describe, expect, test } from 'bun:test'
import type { EngineSession, OpenSessionSpec } from '@poietica/engine'
import { createFakeEngine, type ScenarioScript } from '@poietica/engine-testkit'
import { createTestLogger, fakeClock, waitFor } from '@poietica/test-kit'
import { IDLE_TTL_MS, MAX_IDLE_SESSIONS, SessionPool, SWEEP_INTERVAL_MS } from '../session-pool'
import { deferredOpenEngine } from './helpers'

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

/**
 * 可控的引擎包装（R-03 §4.1）：`openSession` 停在一个由测试手动 resolve 的 deferred 上，
 * 记录每条会话是否被 dispose、onOpened 收到哪些线程，以及所有打开过的 spec。
 */
function controlledPool(opts: {
  clock: ReturnType<typeof fakeClock>
  script?: ScenarioScript
  describe?: (threadId: string) => OpenSessionSpec
  onOpened?: (threadId: string, session: EngineSession) => void
}) {
  const controlled = deferredOpenEngine(createFakeEngine(opts.script === undefined ? {} : { script: opts.script }))
  const engine = controlled.engine
  const openedCalls: string[] = []
  const released: string[] = []
  const described: string[] = []
  const pool = new SessionPool({
    engine,
    clock: opts.clock,
    logger: createTestLogger(),
    describe: (threadId) => {
      described.push(threadId)
      return (
        opts.describe?.(threadId) ?? {
          key: threadId,
          cwd: 'C:\\tmp',
          sessionFile: null,
          posture: 'auto-edit',
          model: null,
          thinking: null,
        }
      )
    },
    onOpened: (threadId, session) => {
      openedCalls.push(threadId)
      opts.onOpened?.(threadId, session)
    },
    onEvent: () => undefined,
    onReleased: (threadId) => released.push(threadId),
  })

  return {
    pool,
    engine,
    get pending() {
      return controlled.pending
    },
    disposed: controlled.disposed,
    openedCalls,
    released,
    described,
    resolveOpen: controlled.resolveOpen,
  }
}

/** 排空微任务：queueMicrotask 的换代释放链与 dispose 的 await 链都在这几拍里跑完 */
async function flushMicrotasks(times = 16): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve()
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

describe('R-03 §4.1 会话池：打开中的释放 / 换代 / 绑定失败', () => {
  test('P1 打开中 release：打开完成即丢弃，acquire 得到 kernel.cancelled', async () => {
    const clock = fakeClock()
    const c = controlledPool({ clock })
    const acquired = c.pool.acquire('t1')
    let released = false
    const releasedDone = c.pool.release('t1').then(() => {
      released = true
    })
    await flushMicrotasks()
    // 打开还没落地：release 在等它收尾，会话还没被 dispose
    expect(released).toBe(false)
    expect(c.disposed).toHaveLength(0)

    const session = await c.resolveOpen(0)
    await releasedDone
    expect(released).toBe(true)
    expect(c.disposed).toEqual([session])
    expect(c.pool.peek('t1')).toBeUndefined()
    expect(c.openedCalls).not.toContain('t1')
    const err = await acquired.catch((e: unknown) => e)
    expect((err as { code?: string }).code).toBe('kernel.cancelled')
  })

  test('P2 打开中 dispose：会话被 dispose，之后 acquire 拒绝', async () => {
    const clock = fakeClock()
    const c = controlledPool({ clock })
    const acquired = c.pool.acquire('t1')
    const disposing = c.pool.dispose()
    const session = await c.resolveOpen(0)
    await disposing
    expect(c.disposed).toEqual([session])
    expect(((await acquired.catch((e: unknown) => e)) as { code?: string }).code).toBe('kernel.cancelled')
    expect(((await c.pool.acquire('t1').catch((e: unknown) => e)) as { code?: string }).code).toBe('kernel.cancelled')
  })

  test('P3 忙会话 invalidate 后第一次 idle 才释放；下一次 acquire 重新打开', async () => {
    const clock = fakeClock()
    const c = controlledPool({
      clock,
      script: () => [{ kind: 'interaction', interaction: { kind: 'confirm', title: '继续吗', message: '等一句回答' } }],
    })
    const acquired = c.pool.acquire('t1')
    const session = await c.resolveOpen(0)
    expect(await acquired).toBe(session)
    await session.submit({ text: '跑起来', images: [], files: [], skills: [], deliverAs: 'turn' })
    await clock.advanceAsync(1)
    expect(session.isBusy()).toBe(true)

    await c.pool.invalidate()
    expect(c.pool.peek('t1')).toBe(session)
    expect(c.disposed).toHaveLength(0)

    // 这一轮结束（idle）→ 旧代的会话在第一次空闲时被释放
    await session.cancel()
    await waitFor(() => c.released.includes('t1'), { message: '旧代会话没有在空闲时释放' })
    expect(c.pool.peek('t1')).toBeUndefined()
    expect(c.disposed).toEqual([session])

    const again = c.pool.acquire('t1')
    await c.resolveOpen(1)
    expect(await again).not.toBe(session)
    expect(c.engine.opened.length).toBe(2)
  })

  test('P4 打开中 invalidate：落地后是旧代，下一次 acquire 释放并重开', async () => {
    const clock = fakeClock()
    const c = controlledPool({ clock })
    const acquired = c.pool.acquire('t1')
    await c.pool.invalidate()
    const session = await c.resolveOpen(0)
    expect(await acquired).toBe(session)
    expect(c.pool.peek('t1')).toBe(session)

    const next = c.pool.acquire('t1')
    await waitFor(() => c.disposed.includes(session), { message: '旧代会话没有被释放' })
    await waitFor(() => c.pending.length === 2, { message: '没有按新配置重开' })
    const reopened = await c.resolveOpen(1)
    expect(await next).toBe(reopened)
    expect(reopened).not.toBe(session)
    expect(c.engine.opened.length).toBe(2)
  })

  test('P5 onOpened 抛异常：acquire 拒绝、会话被 dispose，下一次 acquire 重开', async () => {
    const clock = fakeClock()
    let attempts = 0
    const c = controlledPool({
      clock,
      onOpened: () => {
        attempts += 1
        if (attempts === 1) throw new Error('绑定失败')
      },
    })
    const acquired = c.pool.acquire('t1')
    const rejected = acquired.catch((e: unknown) => e)
    const session = await c.resolveOpen(0)
    const err = await rejected
    expect((err as Error).message).toBe('绑定失败')
    expect(c.disposed).toEqual([session])
    expect(c.pool.peek('t1')).toBeUndefined()
    expect(c.pool.isOpening('t1')).toBe(false)

    // 半绑定的会话没有留在池里：下一次 acquire 会重新打开
    const again = c.pool.acquire('t1')
    const second = await c.resolveOpen(1)
    expect(await again).toBe(second)
    expect(c.engine.opened.length).toBe(2)
  })

  test('P7 release 之后立刻 acquire：拿到的是新会话，不是被取消的那条', async () => {
    const clock = fakeClock()
    const c = controlledPool({ clock })
    const first = c.pool.acquire('t1')
    const released = c.pool.release('t1')
    const second = c.pool.acquire('t1')

    const cancelled = await c.resolveOpen(0)
    expect(((await first.catch((e: unknown) => e)) as { code?: string }).code).toBe('kernel.cancelled')
    await released
    await waitFor(() => c.pending.length === 2, { message: '取消之后没有开新会话' })
    const fresh = await c.resolveOpen(1)
    expect(await second).toBe(fresh)
    expect(fresh).not.toBe(cancelled)
    expect(c.disposed).toEqual([cancelled])
  })

  test('P6 回归：并发 acquire 只打开一次；忙会话不会被溢出驱逐', async () => {
    const clock = fakeClock()
    const c = controlledPool({
      clock,
      script: () => [{ kind: 'interaction', interaction: { kind: 'confirm', title: '继续吗', message: '等一句回答' } }],
    })
    const concurrent = Promise.all([c.pool.acquire('busy'), c.pool.acquire('busy'), c.pool.acquire('busy')])
    expect(c.pending.length).toBe(1)
    const busy = await c.resolveOpen(0)
    expect((await concurrent).every((session) => session === busy)).toBe(true)

    await busy.submit({ text: '跑起来', images: [], files: [], skills: [], deliverAs: 'turn' })
    await clock.advanceAsync(1)
    expect(busy.isBusy()).toBe(true)

    // 塞满空闲位并越过上限：被挤出的只能是空闲的那条，忙的那条留在池里且没被 dispose
    for (let i = 1; i <= MAX_IDLE_SESSIONS + 2; i++) {
      const pending = c.pool.acquire(`idle-${i}`)
      await c.resolveOpen(i)
      await pending
    }
    expect(c.released.length).toBeGreaterThan(0)
    expect(c.pool.peek('busy')).toBe(busy)
    expect(c.disposed).not.toContain(busy)
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
