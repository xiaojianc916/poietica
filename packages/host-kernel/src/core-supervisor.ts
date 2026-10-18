import { type ChildProcess, spawn as nodeSpawn } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import type { CORE_FAILURE_REASONS, CORE_STATUS_STATES } from '@poietica/contract-kit'
import {
  AppError,
  type Clock,
  Deferred,
  type Disposable,
  Emitter,
  LineSplitter,
  type Logger,
  SystemErrorCode,
  systemClock,
  withTimeout,
} from '@poietica/foundation'
import { killTree, listProcesses, type ProcessInfo } from '@poietica/process-kit'
import { type InboundContext, type RpcMeta, RpcPeer } from '@poietica/rpc'
import { createChildProcessTransport } from '@poietica/rpc/stdio'
import { buildCoreLaunch, CORE_EXIT_CODES, CORE_SHUTDOWN_BUDGET_MS, type DataLayout } from '@poietica/runtime-layout'
import type { CoreOutputSink } from './core-output'
import { findStaleCoreProcesses, reapStaleCoreProcesses, type StaleProcess } from './core-reaper'
import { pickFreePort } from './relay-port'
import { ensureRelayToken } from './relay-token'

export type CoreStatusState = (typeof CORE_STATUS_STATES)[number]
export type CoreFailureReason = (typeof CORE_FAILURE_REASONS)[number]
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
/** stderr 单行上限：失控的输出没有换行时，不让它在主进程里无限攒 */
const STDERR_LINE_MAX = 1024 * 1024

/**
 * Core 的 browser relay：端口由 Host 每次拉起 Core 时挑选，口令由 Host 按数据根生成（runtime-layout 的 relay-token.ts）。
 * 两者一起交出去：只拿端口连 `/ext` 会被 relay 以 401 拒绝。
 */
export interface RelayEndpoint {
  readonly port: number
  readonly token: string
}

export interface CoreSupervisorOptions {
  readonly layout: DataLayout
  readonly coreExe: string
  readonly homeDir: string
  readonly strict: boolean
  readonly logLevel: () => 'debug' | 'info' | 'warn' | 'error'
  readonly baseEnv: () => Readonly<Record<string, string | undefined>>
  readonly protocolVersion: number
  readonly logger: Logger
  /** Core 的意外输出（stderr 行、stdout 杂散文本）；Core 的结构化日志由 Core 自己写 core.log */
  readonly coreOutput: CoreOutputSink
  readonly onRequest: (method: string, params: unknown, ctx: InboundContext) => Promise<unknown>
  readonly onNotification: (method: string, params: unknown) => void
  /** 测试注入用。 */
  readonly spawn?: typeof nodeSpawn
  readonly clock?: Clock
  readonly pickPort?: () => Promise<number>
  readonly kill?: (pid: number) => Promise<void>
  /** 测试注入用：默认 READY_TIMEOUT_MS，注入短值即可验证超时行为，不必真等 45 秒。 */
  readonly readyTimeoutMs?: number
  /**
   * 测试注入用：列出系统进程（启动前清理残留、关停后收拾 omp 后台进程）。
   * 默认走 process-kit 的 PowerShell 实现；注入空表就等价于「这台机器上没有残留」。
   */
  readonly listProcesses?: () => Promise<ProcessInfo[]>
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
  private relay: RelayEndpoint | null = null
  private restartTimer: Disposable | undefined
  private stopped: Deferred<void> | undefined
  /** 启动前清掉的残留（诊断与测试用） */
  private reaped: StaleProcess[] = []
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

  relayEndpoint(): RelayEndpoint | null {
    return this.relay
  }

  /** 最近一次启动前清掉的上代 Core / omp 后台进程（诊断与测试用） */
  reapedProcesses(): readonly StaleProcess[] {
    return this.reaped
  }

  /** 首次启动，或从 failed / stopped 重新启动 */
  async start(): Promise<void> {
    if (this.state !== 'idle' && this.state !== 'failed' && this.state !== 'stopped') return
    this.reason = null
    this.setState('starting')
    // 上一代 Core 与它派发的 omp 后台进程必须先清干净（refactor-log R-37）：后者占着 exe 与 SQLite，
    // 不清就会「新 Host + 旧 Core」→ 协议不一致直接 failed，而且覆盖安装也修不好。
    await this.reapBeforeLaunch()
    await this.launchSafely()
  }

  /** 启动前的残留清理。失败只记日志，不影响启动（清理是尽力而为）。 */
  private async reapBeforeLaunch(): Promise<void> {
    try {
      this.reaped = await reapStaleCoreProcesses({
        logger: this.o.logger,
        ownPid: this.child?.pid,
        coreExe: this.o.coreExe,
        ...(this.o.listProcesses === undefined ? {} : { list: this.o.listProcesses }),
        ...(this.o.kill === undefined ? {} : { kill: this.o.kill }),
      })
    } catch (e) {
      this.o.logger.warn('残留进程清理失败，继续启动', { error: String(e) })
      this.reaped = []
    }
  }

  /** 清空崩溃记录，停止当前进程（如有），再启动。 */
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
      /* 先落状态再清：清理要跑一次进程枚举，不能让它把状态机卡在 starting（那时 launch 还会继续 spawn） */
      this.setState('stopped')
      /* 本代 Core 已经退出了：它派发的 omp 后台进程可以收了（不占 exe 的话，下次升级就不会卡安装） */
      await this.reapAfterStop()
      return
    }
    this.stopped = new Deferred<void>()
    this.setState('stopping')
    this.peer?.request('core.shutdown', {}, { timeoutMs: 2_000 }).catch(() => undefined)
    try {
      /* 走注入的 clock：默认是 systemClock（生产行为不变），测试注入 fakeClock 时不必真等满 10 秒 */
      await withTimeout(this.stopped.promise, STOP_GRACE_MS, () => new Error('stop timeout'), this.clock)
    } catch {
      this.o.logger.warn('core did not exit in time, killing')
      if (child.pid !== undefined) await (this.o.kill ?? killTree)(child.pid)
      await withTimeout(this.stopped.promise, 2_000, () => new Error('kill timeout'), this.clock).catch(() => undefined)
    }
    this.setState('stopped')
    /* 等清理跑完再返回：Host 退出流程在这个调用之后就要 exit，残留必须在这之前收掉 */
    await this.reapAfterStop()
  }

  /**
   * 关停后收拾本代 Core 派发的 omp 后台进程（detached 的 daemon broker、lsp mux、blob broker……）。
   *
   * 它们**不在** Core 的进程树里，taskkill /T 收不到；不止血的话，每次正常退出都会在后台留一个
   * 占着 core.exe 的进程 —— 这正是 0.5.10 覆盖安装失败、装成「新 Host + 旧 Core」的直接原因。
   * 只在**真的关停**时做（stop / 退出），不在崩溃重启时做：崩溃那一路由退避重启接管，
   * 新 Core 起来前也会先 reapBeforeLaunch 一次。
   */
  private async reapAfterStop(): Promise<void> {
    const list = this.o.listProcesses ?? listProcesses
    try {
      const processes = await list()
      const stale = findStaleCoreProcesses(processes, undefined, this.o.coreExe)
      if (stale.length === 0) return
      this.o.logger.info('清理 Core 派发的 omp 后台进程', {
        processes: stale.map((s) => ({ pid: s.pid, what: s.what })),
      })
      const kill = this.o.kill ?? killTree
      for (const s of stale) {
        try {
          await kill(s.pid)
        } catch (e) {
          this.o.logger.warn('清理 omp 后台进程失败', { pid: s.pid, error: String(e) })
        }
      }
    } catch (e) {
      this.o.logger.warn('清点 omp 后台进程失败', { error: String(e) })
    }
  }

  /** 立即杀掉（Windows 注销 / 关机时的 session-end）。 */
  killNow(): void {
    this.restartTimer?.dispose()
    this.state = 'stopping'
    if (this.child?.pid !== undefined) void (this.o.kill ?? killTree)(this.child.pid)
  }

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

  /**
   * launch 的唯一入口：launch 里任何一步抛错（取端口、建目录、spawn 同步抛错）都按「这一代起不来」处理，
   * 走与崩溃同一条退避路径。否则 start() 的 Promise 带着异常被 `void` 掉，状态永远停在 starting，
   * UI 只能看到每个请求排队 30 秒后报「Core 启动超时」，而看护人再也不会重试。
   */
  private async launchSafely(): Promise<void> {
    const gen = this.generation + 1
    try {
      await this.launch()
    } catch (e) {
      if (this.stale(gen)) return
      this.o.logger.error('core launch failed', { error: String(e) })
      /* 进程已经 spawn 出来（抛错发生在接线阶段）：杀掉它，由它的 'exit' 走 onExit；否则直接记一次崩溃 */
      const child = this.child
      if (child?.pid !== undefined && child.exitCode === null) {
        await (this.o.kill ?? killTree)(child.pid)
        return
      }
      this.peer?.dispose()
      this.peer = undefined
      this.child = undefined
      this.crashed()
    }
  }

  private async launch(): Promise<void> {
    const gen = ++this.generation
    if (!existsSync(this.o.coreExe)) {
      this.fail('core_missing')
      return
    }
    const port = await (this.o.pickPort ?? pickFreePort)()
    if (this.stale(gen)) return
    this.relay = { port, token: ensureRelayToken(this.o.layout.relayTokenFile) }
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
    const transport = createChildProcessTransport(child, { onStray: (text) => this.o.coreOutput.stray(text) })
    const stderr = new LineSplitter((line) => this.o.coreOutput.line(line), {
      maxLineLength: STDERR_LINE_MAX,
      onOverflow: (head) => this.o.coreOutput.line(`[stderr line overflow] ${head}`),
    })
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
    /*
     * 'exit' 与「spawn 失败的 'error'」都表示这一代结束了，但 Node 不保证 spawn 失败之后还会有 'exit'
     * （ENOENT / EACCES / 杀软占用 exe 时的 EBUSY、EPERM 都只发 'error'）。两者收进同一个只走一次的出口；
     * 已经起来的进程上的 'error'（例如 kill 失败）不是退出，只记日志。
     */
    let ended = false
    const end = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (ended) return
      ended = true
      stderr.flush()
      this.onExit(gen, code, signal)
    }
    child.once('error', (err) => {
      this.o.logger.error('core spawn error', { error: String(err), spawned: child.pid !== undefined })
      ready.reject(err)
      if (child.pid === undefined) end(null, null)
    })
    child.once('exit', (code, signal) => end(code, signal))

    let payload: ReadyPayload
    try {
      payload = await withTimeout(
        ready.promise,
        this.o.readyTimeoutMs ?? READY_TIMEOUT_MS,
        () => new Error('ready timeout'),
      )
    } catch (e) {
      // 代际过期也要清掉自己这一代 spawn 出来的进程（R-05 §3.4）
      if (this.stale(gen)) {
        await this.killChild(child)
        return
      }
      this.o.logger.error('core did not become ready', { error: String(e) })
      /* 只有真的等满了才是 start_timeout；spawn 失败已经由上面的出口按崩溃处理过了 */
      if (child.pid !== undefined && this.reason === null) this.reason = 'start_timeout'
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
    this.o.logger.info('core ready', { ...payload, pid: child.pid, relayPort: this.relay?.port })
    this.reason = null
    this.setState('ready')
    this.readyEmitter.fire()
  }

  /**
   * 代际是否已过期（R-05 §3.4）。`idle` 也算：restart() 先置 idle 再 start()，而 start() 立刻
   * setState('starting') 并在 launch 里 ++generation —— 新一代不会被误判，落在中间的旧一代一律收手。
   */
  private stale(gen: number): boolean {
    return gen !== this.generation || this.state === 'stopping' || this.state === 'stopped' || this.state === 'idle'
  }

  /** 只杀自己这一代、还没退出的 child —— 已经退出的 pid 不能再杀。 */
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
    /* 确定性失败（R-08-8）：降级安装 / 装配期就失败，重试不会改变结果 */
    if (code === CORE_EXIT_CODES.dataTooNew) {
      this.fail('data_too_new')
      return
    }
    if (code === CORE_EXIT_CODES.startFailed) {
      this.fail('start_failed')
      return
    }
    this.crashed()
  }

  /** 这一代非确定性地结束了（崩溃、起不来）：记一次崩溃，退避后重启；窗口内超过上限进 failed/crash_loop。 */
  private crashed(): void {
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
      if (this.state === 'restarting') void this.launchSafely()
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
