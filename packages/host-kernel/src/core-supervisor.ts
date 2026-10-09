import { type ChildProcess, spawn as nodeSpawn } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import {
  AppError,
  type Clock,
  Deferred,
  type Disposable,
  Emitter,
  type Logger,
  SystemErrorCode,
  systemClock,
  withTimeout,
} from '@poietica/foundation'
import { killTree, LineSplitter } from '@poietica/process-kit'
import { type InboundContext, type RpcMeta, RpcPeer } from '@poietica/rpc'
import { createChildProcessTransport } from '@poietica/rpc/stdio'
import { buildCoreLaunch, CORE_EXIT_CODES, CORE_SHUTDOWN_BUDGET_MS, type DataLayout } from '@poietica/runtime-layout'
import type { CoreLogSink } from './core-log-sink'
import { pickFreePort } from './relay-port'

export type CoreStatusState = 'starting' | 'ready' | 'restarting' | 'failed' | 'stopped'
export type CoreFailureReason =
  | 'start_timeout'
  | 'crashed'
  | 'crash_loop'
  | 'isolation_violated'
  | 'bad_arguments'
  | 'protocol_mismatch'
  | 'core_missing'
export interface CoreStatus {
  readonly state: CoreStatusState
  readonly reason: CoreFailureReason | null
  readonly attempt: number
}

type InternalState = 'idle' | 'starting' | 'ready' | 'restarting' | 'failed' | 'stopping' | 'stopped'

export const BACKOFF_MS = [500, 1_000, 2_000, 4_000, 8_000] as const
export const CRASH_WINDOW_MS = 60_000
export const MAX_CRASHES_IN_WINDOW = 5
export const READY_TIMEOUT_MS = 45_000
/**
 * Host 等 Core 自己退出的宽限期（R-05 §3.3）：必须比 Core 的关停总预算更长，
 * 否则 Core 还在逐条关会话 / flush 设置时就被 killTree 杀掉，数据库也没来得及 close。
 */
export const STOP_GRACE_MS = CORE_SHUTDOWN_BUDGET_MS + 2_000
export const QUEUE_WAIT_MS = 30_000

export interface CoreSupervisorOptions {
  readonly layout: DataLayout
  readonly coreExe: string
  readonly homeDir: string
  readonly strict: boolean
  readonly logLevel: () => 'debug' | 'info' | 'warn' | 'error'
  readonly baseEnv: () => Readonly<Record<string, string | undefined>>
  readonly protocolVersion: number
  readonly logger: Logger
  readonly coreLog: CoreLogSink
  readonly onRequest: (method: string, params: unknown, ctx: InboundContext) => Promise<unknown>
  readonly onNotification: (method: string, params: unknown) => void
  /** 测试注入 */
  readonly spawn?: typeof nodeSpawn
  readonly clock?: Clock
  readonly pickPort?: () => Promise<number>
  readonly kill?: (pid: number) => Promise<void>
}

interface ReadyPayload {
  readonly coreVersion: string
  readonly protocolVersion: number
  readonly engineVersion: string
}

export class CoreSupervisor {
  private state: InternalState = 'idle'
  private reason: CoreFailureReason | null = null
  private crashes: number[] = []
  private child: ChildProcess | undefined
  private peer: RpcPeer | undefined
  private generation = 0
  private port: number | null = null
  private restartTimer: Disposable | undefined
  private stopped: Deferred<void> | undefined
  private readonly statusEmitter = new Emitter<CoreStatus>()
  private readonly readyEmitter = new Emitter<void>()
  readonly onStatus = this.statusEmitter.event
  private readonly clock: Clock

  constructor(private readonly o: CoreSupervisorOptions) {
    this.clock = o.clock ?? systemClock
  }

  get status(): CoreStatus {
    const map: Record<InternalState, CoreStatusState> = {
      idle: 'starting',
      starting: 'starting',
      ready: 'ready',
      restarting: 'restarting',
      failed: 'failed',
      stopping: 'stopped',
      stopped: 'stopped',
    }
    return { state: map[this.state], reason: this.reason, attempt: this.crashes.length }
  }

  relayPort(): number | null {
    return this.port
  }

  /** 首次启动，或从 failed / stopped 重新启动 */
  async start(): Promise<void> {
    if (this.state !== 'idle' && this.state !== 'failed' && this.state !== 'stopped') return
    this.reason = null
    this.setState('starting')
    await this.launch()
  }

  /** UI 的“重新启动 Core”：清空崩溃记录，停止当前进程（如有），再启动 */
  async restart(): Promise<void> {
    this.crashes = []
    if (this.child !== undefined) await this.stop()
    this.restartTimer?.dispose()
    this.restartTimer = undefined
    this.state = 'idle'
    await this.start()
  }

  /** 优雅停止：core.shutdown → 最多等 STOP_GRACE_MS → killTree */
  async stop(): Promise<void> {
    this.restartTimer?.dispose()
    this.restartTimer = undefined
    const child = this.child
    if (child === undefined) {
      this.setState('stopped')
      return
    }
    this.stopped = new Deferred<void>()
    this.setState('stopping')
    this.peer?.request('core.shutdown', {}, { timeoutMs: 2_000 }).catch(() => undefined)
    try {
      await withTimeout(this.stopped.promise, STOP_GRACE_MS, () => new Error('stop timeout'))
    } catch {
      this.o.logger.warn('core did not exit in time, killing')
      if (child.pid !== undefined) await (this.o.kill ?? killTree)(child.pid)
      await withTimeout(this.stopped.promise, 2_000, () => new Error('kill timeout')).catch(() => undefined)
    }
    this.setState('stopped')
  }

  /** 立即杀掉（Windows 注销/关机时的 session-end） */
  killNow(): void {
    this.restartTimer?.dispose()
    this.state = 'stopping'
    if (this.child?.pid !== undefined) void (this.o.kill ?? killTree)(this.child.pid)
  }

  /** RpcHub 转发 UI 请求、Host 模块调用 Core 都走这里 */
  async forward(
    method: string,
    params: unknown,
    opts: { signal: AbortSignal; meta: RpcMeta | undefined },
  ): Promise<unknown> {
    await this.waitUntilReady(opts.signal)
    const peer = this.peer!
    const gen = this.generation
    try {
      return await peer.request(method, params, {
        timeoutMs: 0,
        signal: opts.signal,
        ...(opts.meta === undefined ? {} : { meta: opts.meta }),
      })
    } catch (e) {
      // 连接在请求途中断开：onExit 已经把状态改成 restarting / failed（或者已经开始了新的一代）
      const interrupted =
        e instanceof AppError &&
        e.code === SystemErrorCode.coreUnavailable &&
        (gen !== this.generation || this.state !== 'ready')
      if (interrupted && this.state !== 'stopping' && this.state !== 'stopped') {
        throw new AppError(SystemErrorCode.coreRestarted, 'Core 已重启，请求被中断，请重试')
      }
      throw e
    }
  }

  private async waitUntilReady(signal: AbortSignal): Promise<void> {
    if (this.state === 'ready') return
    if (this.state === 'failed' || this.state === 'stopping' || this.state === 'stopped') {
      throw new AppError(SystemErrorCode.coreUnavailable, `Core 不可用（${this.reason ?? this.state}）`)
    }
    await new Promise<void>((resolve, reject) => {
      const subs: Disposable[] = []
      const done = (err?: AppError): void => {
        for (const s of subs) s.dispose()
        signal.removeEventListener('abort', onAbort)
        if (err) reject(err)
        else resolve()
      }
      const onAbort = (): void => done(new AppError(SystemErrorCode.cancelled, '请求已取消'))
      signal.addEventListener('abort', onAbort, { once: true })
      subs.push(this.readyEmitter.event(() => done()))
      subs.push(
        this.onStatus((s) => {
          if (s.state === 'failed' || s.state === 'stopped') {
            done(new AppError(SystemErrorCode.coreUnavailable, `Core 不可用（${s.reason ?? s.state}）`))
          }
        }),
      )
      subs.push(
        this.clock.setTimeout(
          () => done(new AppError(SystemErrorCode.coreUnavailable, 'Core 启动超时')),
          QUEUE_WAIT_MS,
        ),
      )
    })
  }

  private async launch(): Promise<void> {
    const gen = ++this.generation
    if (!existsSync(this.o.coreExe)) {
      this.fail('core_missing')
      return
    }
    const port = await (this.o.pickPort ?? pickFreePort)()
    if (this.stale(gen)) return
    this.port = port
    const launch = buildCoreLaunch({
      coreExe: this.o.coreExe,
      dataRoot: this.o.layout.root,
      homeDir: this.o.homeDir,
      relayPort: port,
      logLevel: this.o.logLevel(),
      strict: this.o.strict,
      baseEnv: this.o.baseEnv(),
    })
    for (const dir of launch.mustExistDirs) mkdirSync(dir, { recursive: true })
    const child = (this.o.spawn ?? nodeSpawn)(launch.command, [...launch.args], {
      cwd: launch.cwd,
      env: launch.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    this.child = child
    const ready = new Deferred<ReadyPayload>()
    const transport = createChildProcessTransport(child, { onStray: (text) => this.o.coreLog.stray(text) })
    const stderr = new LineSplitter((line) => this.o.coreLog.line(line))
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => stderr.push(chunk))
    this.peer = new RpcPeer({
      name: 'host→core',
      transport,
      logger: this.o.logger,
      onRequest: this.o.onRequest,
      onNotification: (method, params) => {
        if (method === 'core.ready') ready.resolve(params as ReadyPayload)
        else this.o.onNotification(method, params)
      },
    })
    child.once('error', (err) => {
      this.o.logger.error('core spawn error', { error: String(err) })
      ready.reject(err)
    })
    child.once('exit', (code, signal) => {
      stderr.flush()
      this.onExit(gen, code, signal)
    })

    let payload: ReadyPayload
    try {
      payload = await withTimeout(ready.promise, READY_TIMEOUT_MS, () => new Error('ready timeout'))
    } catch (e) {
      // 代际过期也要清掉自己这一代 spawn 出来的进程（R-05 §3.4）
      if (this.stale(gen)) {
        await this.killChild(child)
        return
      }
      this.o.logger.error('core did not become ready', { error: String(e) })
      this.reason = 'start_timeout'
      await this.killChild(child)
      return // 由 onExit 进入退避重启
    }
    if (this.stale(gen)) {
      await this.killChild(child)
      return
    }
    if (payload.protocolVersion !== this.o.protocolVersion) {
      this.o.logger.error('protocol mismatch', { core: payload.protocolVersion, host: this.o.protocolVersion })
      this.fail('protocol_mismatch')
      if (child.pid !== undefined) await (this.o.kill ?? killTree)(child.pid)
      return
    }
    this.o.logger.info('core ready', { ...payload, pid: child.pid, relayPort: this.port })
    this.reason = null
    this.setState('ready')
    this.readyEmitter.fire()
  }

  /**
   * 代际是否已过期（R-05 §3.4）。
   *
   * `idle` 也算：restart() 先置 idle 再 start()，而 start() 立刻 setState('starting')
   * 并在 launch 里 ++generation —— 新一代不会被误判，落在中间的旧一代一律收手。
   */
  private stale(gen: number): boolean {
    return gen !== this.generation || this.state === 'stopping' || this.state === 'stopped' || this.state === 'idle'
  }

  /** 只杀自己这一代、还没退出的 child（已经退出的 pid 不能再杀） */
  private async killChild(child: ChildProcess): Promise<void> {
    if (child.pid !== undefined && child.exitCode === null) await (this.o.kill ?? killTree)(child.pid)
  }

  private onExit(gen: number, code: number | null, signal: NodeJS.Signals | null): void {
    if (gen !== this.generation) return
    this.peer?.dispose()
    this.peer = undefined
    this.child = undefined
    this.o.logger.info('core exited', { code, signal, state: this.state })
    if (this.state === 'stopping') {
      this.stopped?.resolve()
      return
    }
    if (this.state === 'failed') return
    if (code === CORE_EXIT_CODES.isolationViolated) {
      this.fail('isolation_violated')
      return
    }
    if (code === CORE_EXIT_CODES.badArguments) {
      this.fail('bad_arguments')
      return
    }
    const now = this.clock.now()
    this.crashes = [...this.crashes.filter((t) => now - t < CRASH_WINDOW_MS), now]
    if (this.crashes.length > MAX_CRASHES_IN_WINDOW) {
      this.fail('crash_loop')
      return
    }
    const delay = BACKOFF_MS[Math.min(this.crashes.length - 1, BACKOFF_MS.length - 1)]!
    if (this.reason === null) this.reason = 'crashed'
    this.setState('restarting')
    this.restartTimer = this.clock.setTimeout(() => {
      this.restartTimer = undefined
      if (this.state === 'restarting') void this.launch()
    }, delay)
  }

  private fail(reason: CoreFailureReason): void {
    this.reason = reason
    this.setState('failed')
  }

  private setState(next: InternalState): void {
    this.state = next
    this.statusEmitter.fire(this.status)
  }
}
