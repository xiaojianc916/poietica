import { describe, expect, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { type AppError, SystemErrorCode } from '@poietica/foundation'
import { encodeFrame } from '@poietica/rpc'
import { type DataLayout, dataLayout } from '@poietica/runtime-layout'
import { createTestLogger, type FakeClock, fakeClock, type TempDir, tempDir } from '@poietica/test-kit'
import type { CoreLogSink } from '../core-log-sink'
import { CoreSupervisor, type CoreSupervisorOptions } from '../core-supervisor'

interface FakeChild extends EventEmitter {
  pid: number
  stdin: PassThrough
  stdout: PassThrough
  stderr: PassThrough
  killed: boolean
}

interface Spawned {
  readonly child: FakeChild
  readonly command: string
  readonly args: readonly string[]
}

function makeSpawn(): { spawn: unknown; spawned: Spawned[]; killed: number[] } {
  const spawned: Spawned[] = []
  const killed: number[] = []
  let nextPid = 1000
  const spawn = (command: string, args: readonly string[]): FakeChild => {
    const child = new EventEmitter() as FakeChild
    child.pid = nextPid++
    child.stdin = new PassThrough()
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.killed = false
    spawned.push({ child, command, args })
    return child
  }
  return { spawn, spawned, killed }
}

/** 让 launch() 里的 await（pickPort、mkdir）走完，使子进程真正被创建 */
async function tick(times = 5): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve()
}

function ready(child: FakeChild, protocolVersion = 1, coreVersion = 'c', engineVersion = 'e'): void {
  child.stdout.write(
    encodeFrame({ jsonrpc: '2.0', method: 'core.ready', params: { coreVersion, protocolVersion, engineVersion } }),
  )
}

function exitChild(child: FakeChild, code: number | null): void {
  child.emit('exit', code, null)
}

interface Setup {
  readonly sup: CoreSupervisor
  readonly clock: FakeClock
  readonly spawned: Spawned[]
  readonly killed: number[]
  readonly dir: TempDir
  readonly log: ReturnType<typeof createTestLogger>
}

async function setup(
  overrides: Partial<CoreSupervisorOptions> = {},
  opts: { coreExeExists?: boolean } = {},
): Promise<Setup> {
  const dir = await tempDir('supervisor-')
  const layout: DataLayout = dataLayout(dir.path)
  const clock = fakeClock()
  const log = createTestLogger()
  const { spawn, spawned, killed } = makeSpawn()
  const coreLog: CoreLogSink = { line: () => undefined, stray: () => undefined }
  const coreExe = opts.coreExeExists === false ? `${dir.path}/missing.exe` : process.execPath
  const sup = new CoreSupervisor({
    layout,
    coreExe,
    homeDir: dir.path,
    strict: true,
    logLevel: () => 'debug',
    baseEnv: () => ({ PATH: 'x' }),
    protocolVersion: 1,
    logger: log,
    coreLog,
    onRequest: async () => ({}),
    onNotification: () => undefined,
    spawn: spawn as never,
    clock,
    pickPort: async () => 12345,
    kill: async (pid) => {
      killed.push(pid)
      const found = spawned.find((s) => s.child.pid === pid)
      if (found !== undefined) setTimeout(() => exitChild(found.child, 0), 0)
    },
    ...overrides,
  })
  return { sup, clock, spawned, killed, dir, log }
}

describe('CoreSupervisor', () => {
  test('S-1 子进程 ready 且版本一致 → starting → ready', async () => {
    const s = await setup()
    const states: string[] = []
    s.sup.onStatus((st) => states.push(st.state))
    const started = s.sup.start()
    await tick()
    ready(s.spawned[0]!.child)
    await started
    expect(states).toEqual(['starting', 'ready'])
    expect(s.sup.status.state).toBe('ready')
    expect(s.sup.relayPort()).toBe(12345)
  })

  test('S-2 协议版本不一致 → failed/protocol_mismatch 且杀掉子进程', async () => {
    const s = await setup()
    const started = s.sup.start()
    await tick()
    ready(s.spawned[0]!.child, 2)
    await started
    expect(s.sup.status.state).toBe('failed')
    expect(s.sup.status.reason).toBe('protocol_mismatch')
    expect(s.killed).toContain(s.spawned[0]!.child.pid)
  })

  test('S-3 ready 后退出码 1 → restarting，0.5 秒后再次 spawn', async () => {
    const s = await setup()
    const started = s.sup.start()
    await tick()
    ready(s.spawned[0]!.child)
    await started
    exitChild(s.spawned[0]!.child, 1)
    expect(s.sup.status.state).toBe('restarting')
    expect(s.sup.status.reason).toBe('crashed')
    expect(s.spawned.length).toBe(1)
    s.clock.advance(500)
    await Promise.resolve()
    expect(s.spawned.length).toBe(2)
  })

  test('S-4 连续崩溃：退避 0.5/1/2/4/8；第 6 次（60 秒内）→ failed/crash_loop', async () => {
    const s = await setup()
    const started = s.sup.start()
    await tick()
    ready(s.spawned[0]!.child)
    await started
    const delays: number[] = []
    for (let i = 0; i < 5; i++) {
      const before = s.spawned.length
      exitChild(s.spawned[before - 1]!.child, 1)
      const t0 = s.clock.now()
      // 推进（每次让出微任务，使 spawn 有机会发生）直到下一次 spawn
      let elapsed = 0
      while (s.spawned.length === before && elapsed < 20_000) {
        s.clock.advance(100)
        elapsed += 100
        await Promise.resolve()
      }
      delays.push(s.clock.now() - t0)
      const child = s.spawned[s.spawned.length - 1]!.child
      ready(child)
      await tick()
    }
    expect(delays).toEqual([500, 1_000, 2_000, 4_000, 8_000])
    // 第 6 次崩溃
    exitChild(s.spawned[s.spawned.length - 1]!.child, 1)
    expect(s.sup.status.state).toBe('failed')
    expect(s.sup.status.reason).toBe('crash_loop')
    expect(s.sup.status.attempt).toBe(6)
  })

  test('S-5 退出码 3 → 直接 failed/isolation_violated，不再 spawn', async () => {
    const s = await setup()
    const started = s.sup.start()
    await tick()
    ready(s.spawned[0]!.child)
    await started
    exitChild(s.spawned[0]!.child, 3)
    expect(s.sup.status.state).toBe('failed')
    expect(s.sup.status.reason).toBe('isolation_violated')
    s.clock.advance(60_000)
    expect(s.spawned.length).toBe(1)
  })

  test('S-5b 退出码 2 → failed/bad_arguments，不再 spawn', async () => {
    const s = await setup()
    const started = s.sup.start()
    await tick()
    ready(s.spawned[0]!.child)
    await started
    exitChild(s.spawned[0]!.child, 2)
    expect(s.sup.status.reason).toBe('bad_arguments')
    s.clock.advance(60_000)
    expect(s.spawned.length).toBe(1)
  })

  test('S-6 45 秒不发 ready → 杀进程并按崩溃退避', async () => {
    const s = await setup()
    const started = s.sup.start()
    await tick()
    // READY_TIMEOUT_MS 走的是真实时钟（foundation 的 withTimeout），所以这里真的等 45 秒
    await started
    await new Promise((r) => setTimeout(r, 20)) // 等子进程的 exit 事件（kill 桩里 setTimeout 0）
    expect(s.killed).toContain(s.spawned[0]!.child.pid)
    expect(s.sup.status.state).toBe('restarting')
    expect(s.sup.status.reason).toBe('start_timeout')
  }, 60_000)

  test('S-7 stop()：子进程 1 秒后退出 → 发送了 core.shutdown、状态 stopped、没有杀进程', async () => {
    const s = await setup()
    const started = s.sup.start()
    await tick()
    const child = s.spawned[0]!.child
    ready(child)
    await started
    const requests: unknown[] = []
    child.stdin.on('data', (b: Buffer) => requests.push(b.toString('utf8')))
    const stopping = s.sup.stop()
    await Promise.resolve()
    exitChild(child, 0)
    await stopping
    expect(s.sup.status.state).toBe('stopped')
    expect(s.killed).toEqual([])
    expect(requests.join('')).toContain('core.shutdown')
  })

  test('S-8 stop()：子进程不退出 → 5 秒后 kill', async () => {
    const s = await setup()
    const started = s.sup.start()
    await tick()
    const child = s.spawned[0]!.child
    ready(child)
    await started
    const stopping = s.sup.stop()
    await Promise.resolve()
    // STOP_GRACE_MS 用的是真实时钟：真的等 5 秒
    await stopping
    expect(s.killed).toContain(child.pid)
    expect(s.sup.status.state).toBe('stopped')
  }, 20_000)

  test('S-9 failed 后 restart()：崩溃记录清空，重新 starting', async () => {
    const s = await setup()
    const started = s.sup.start()
    await tick()
    ready(s.spawned[0]!.child)
    await started
    exitChild(s.spawned[0]!.child, 3)
    expect(s.sup.status.state).toBe('failed')
    const restarted = s.sup.restart()
    await tick()
    expect(s.spawned.length).toBe(2)
    ready(s.spawned[1]!.child)
    await restarted
    expect(s.sup.status.state).toBe('ready')
    expect(s.sup.status.attempt).toBe(0)
  })

  test('S-10 starting 期间 forward：等到 ready 后送达', async () => {
    const s = await setup()
    const started = s.sup.start()
    await tick()
    const child = s.spawned[0]!.child
    const ac = new AbortController()
    const forwarded = s.sup.forward('alpha.ping', { n: 1 }, { signal: ac.signal, meta: undefined })
    const replies: string[] = []
    child.stdin.on('data', (b: Buffer) => replies.push(b.toString('utf8')))
    ready(child)
    await started
    await Promise.resolve()
    expect(replies.join('')).toContain('alpha.ping')
    ac.abort()
    await forwarded.catch(() => undefined)
  })

  test('S-10b starting 期间 forward，30 秒未就绪 → kernel.core_unavailable', async () => {
    const s = await setup()
    const started = s.sup.start()
    await tick()
    const ac = new AbortController()
    const forwarded = s.sup.forward('alpha.ping', {}, { signal: ac.signal, meta: undefined })
    const raced = forwarded.catch((e: unknown) => e)
    s.clock.advance(30_000)
    const err = await raced
    expect((err as AppError).code).toBe(SystemErrorCode.coreUnavailable)
    void started
  })

  test('S-10c failed 状态下 forward → kernel.core_unavailable', async () => {
    const s = await setup({}, { coreExeExists: false })
    await s.sup.start()
    const ac = new AbortController()
    const err = await s.sup.forward('x', {}, { signal: ac.signal, meta: undefined }).catch((e: unknown) => e)
    expect((err as AppError).code).toBe(SystemErrorCode.coreUnavailable)
  })

  /*
   * 06 页 §4.5 的 8 个场景之一：「UI 取消排队中的请求 → kernel.cancelled」。
   * 排队发生在 CoreSupervisor.waitUntilReady 里（Hub 只是把 ctx.signal 透传过去），
   * 所以判据落在这一层：abort 之后 forward 必须以 kernel.cancelled 失败，且不重试。
   */
  test('S-10d starting 期间取消排队中的请求 → kernel.cancelled', async () => {
    const s = await setup()
    const started = s.sup.start()
    await tick()
    const ac = new AbortController()
    const forwarded = s.sup.forward('alpha.ping', {}, { signal: ac.signal, meta: undefined })
    const raced = forwarded.catch((e: unknown) => e)
    ac.abort()
    const err = await raced
    expect((err as AppError).code).toBe(SystemErrorCode.cancelled)
    void started
  })

  test('S-11 转发中子进程崩溃 → kernel.core_restarted', async () => {
    const s = await setup()
    const started = s.sup.start()
    await tick()
    const child = s.spawned[0]!.child
    ready(child)
    await started
    const ac = new AbortController()
    const forwarded = s.sup.forward('alpha.ping', {}, { signal: ac.signal, meta: undefined })
    await Promise.resolve()
    exitChild(child, 1)
    const err = await forwarded.catch((e: unknown) => e)
    expect((err as AppError).code).toBe(SystemErrorCode.coreRestarted)
  })

  test('S-12 coreExe 不存在 → failed/core_missing', async () => {
    const s = await setup({}, { coreExeExists: false })
    await s.sup.start()
    expect(s.sup.status.state).toBe('failed')
    expect(s.sup.status.reason).toBe('core_missing')
    expect(s.spawned.length).toBe(0)
  })

  test('killNow 立即杀进程，不再重启', async () => {
    const s = await setup()
    const started = s.sup.start()
    await tick()
    const child = s.spawned[0]!.child
    ready(child)
    await started
    s.sup.killNow()
    expect(s.killed).toContain(child.pid)
    s.clock.advance(60_000)
    expect(s.spawned.length).toBe(1)
  })

  test('状态机对外只有五个 state 值；idle 报告为 starting', async () => {
    const s = await setup()
    expect(s.sup.status.state).toBe('starting')
    expect(s.sup.relayPort()).toBeNull()
  })

  test('启动参数按 buildCoreLaunch 生成（含 --strict 与 relay 端口）', async () => {
    const s = await setup()
    const started = s.sup.start()
    await tick()
    ready(s.spawned[0]!.child)
    await started
    const args = s.spawned[0]!.args
    expect(args[0]).toBe('serve')
    expect(args).toContain('--strict')
    expect(args).toContain('--relay-port')
    expect(args).toContain('12345')
  })

  test('stderr 逐行送到 coreLog', async () => {
    const lines: string[] = []
    const s = await setup({ coreLog: { line: (t) => lines.push(t), stray: () => undefined } })
    const started = s.sup.start()
    await tick()
    const child = s.spawned[0]!.child
    child.stderr.write('one\ntwo\n')
    ready(child)
    await started
    await new Promise((r) => setTimeout(r, 5))
    expect(lines).toContain('one')
    expect(lines).toContain('two')
  })
})
