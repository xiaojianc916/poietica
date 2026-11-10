import { type ChildProcess, spawn as nodeSpawn } from 'node:child_process'
import { AppError, type Logger, SystemErrorCode, withTimeout } from '@poietica/foundation'
import { killTree } from '@poietica/process-kit'
import { type InboundContext, jsonValue, RpcPeer } from '@poietica/rpc'
import { createChildProcessTransport } from '@poietica/rpc/stdio'
import { ARP_VERSION, arpMethods } from '@poietica/runtime-protocol'

/**
 * 单个 Runtime Worker 的生命周期（架构设计 §10）。只管「起进程、握手、停进程」，
 * 工作树路由、崩溃退避与 Run 对账由上层 Manager 组合。传输与控制面共用 rpc 的分帧。
 */
export interface RuntimeLaunch {
  readonly command: string
  readonly args: readonly string[]
  readonly cwd?: string
  readonly env?: Readonly<Record<string, string | undefined>>
}

export interface RuntimeProcessOptions {
  readonly launch: RuntimeLaunch
  readonly logger: Logger
  readonly readyTimeoutMs?: number
  readonly protocolVersion?: number
  readonly spawn?: typeof nodeSpawn
  /** 意外退出后自动重启；默认关闭，由上层（RuntimePool/工作树路由）决定。 */
  readonly autoRestart?: boolean
  readonly backoffMs?: readonly number[]
  readonly restartWindowMs?: number
  /** 心跳间隔；0/缺省 = 关闭。心跳失败会杀掉 Worker，并按 autoRestart 决定是否重启。 */
  readonly heartbeatMs?: number
  readonly heartbeatTimeoutMs?: number
  /** Worker 反向请求（产品工具执行、策略裁决等）。 */
  readonly onRequest?: (method: string, params: unknown, ctx: InboundContext) => Promise<unknown>
  /** 状态变化（starting/ready/failed/restarting/stopped），用于上层做会话恢复。 */
  readonly onState?: (status: { state: RuntimeProcessState; error: string | null; attempt: number }) => void
}

export type RuntimeProcessState = 'idle' | 'starting' | 'ready' | 'restarting' | 'failed' | 'stopped'

export class RuntimeProcess {
  private child: ChildProcess | undefined
  private peer: RpcPeer | undefined
  private state: RuntimeProcessState = 'idle'
  private lastError: string | null = null
  private attempts = 0
  private stopping = false
  private restartTimer: ReturnType<typeof setTimeout> | undefined
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined
  private pinging = false
  private readyAt = 0
  private helloInfo: {
    protocolVersion: number
    runtimeVersion: string
    engineVersion: string
    capabilities: string[]
  } | null = null
  private readonly notificationListeners = new Set<(method: string, params: unknown) => void>()

  constructor(private readonly o: RuntimeProcessOptions) {}

  get status(): { state: RuntimeProcessState; error: string | null; attempt: number } {
    return { state: this.state, error: this.lastError, attempt: this.attempts }
  }

  private setState(state: RuntimeProcessState): void {
    this.state = state
    this.o.onState?.(this.status)
  }

  get hello(): {
    protocolVersion: number
    runtimeVersion: string
    engineVersion: string
    capabilities: string[]
  } | null {
    return this.helloInfo
  }

  onNotification(listener: (method: string, params: unknown) => void): { dispose(): void } {
    this.notificationListeners.add(listener)
    return { dispose: () => this.notificationListeners.delete(listener) }
  }

  async start(): Promise<void> {
    if (this.state === 'ready' || this.state === 'starting') return
    this.stopping = false
    this.setState('starting')
    this.lastError = null
    const spawn = this.o.spawn ?? nodeSpawn
    const child = spawn(this.o.launch.command, [...this.o.launch.args], {
      cwd: this.o.launch.cwd,
      env: { ...process.env, ...this.o.launch.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    this.child = child
    child.stderr?.on('data', (chunk) => this.o.logger.warn('runtime stderr', { text: String(chunk).trim() }))
    const transport = createChildProcessTransport(child, {
      onStray: (text) => this.o.logger.warn('runtime stray stdout', { text }),
    })
    const peer = new RpcPeer({
      name: 'runtime-manager',
      transport,
      logger: this.o.logger,
      defaultTimeoutMs: 30_000,
      onNotification: (method, params) => {
        for (const listener of [...this.notificationListeners]) listener(method, params)
        if (this.notificationListeners.size === 0) this.o.logger.debug('runtime notification', { method })
      },
      ...(this.o.onRequest === undefined ? {} : { onRequest: this.o.onRequest }),
    })
    this.peer = peer
    child.once('exit', (code, signal) => {
      this.peer?.dispose()
      this.peer = undefined
      this.child = undefined
      if (this.stopping || this.state === 'stopped') return
      this.lastError = `Worker 退出：${code ?? signal ?? 'unknown'}`
      if (this.o.autoRestart === true) {
        this.scheduleRestart()
      } else {
        this.setState('failed')
      }
    })
    try {
      const rawHello = await withTimeout(
        peer.request(arpMethods.hello, {
          protocolVersion: this.o.protocolVersion ?? ARP_VERSION,
          coreVersion: 'core',
        }),
        this.o.readyTimeoutMs ?? 10_000,
        () => new AppError(SystemErrorCode.timeout, 'Runtime Worker 握手超时'),
      )
      const hello = jsonValue(rawHello) as { protocolVersion?: number }
      if (hello.protocolVersion !== (this.o.protocolVersion ?? ARP_VERSION)) {
        throw new AppError('runtime.protocol_mismatch', 'Runtime Worker 协议版本不一致')
      }
      this.helloInfo = hello as typeof this.helloInfo
      this.setState('ready')
      this.readyAt = Date.now()
      this.startHeartbeat()
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error)
      this.setState('failed')
      await this.stop()
      throw error
    }
  }

  /** 经 ARP 调 Worker；返回值已从 RawJson 解开。 */
  async request(method: string, params: unknown, timeoutMs = 30_000): Promise<unknown> {
    if (this.peer === undefined) throw new AppError(SystemErrorCode.coreUnavailable, 'Runtime Worker 未就绪')
    return jsonValue(await this.peer.request(method, params, { timeoutMs }))
  }

  async stop(): Promise<void> {
    this.stopping = true
    this.stopHeartbeat()
    if (this.restartTimer !== undefined) {
      clearTimeout(this.restartTimer)
      this.restartTimer = undefined
    }
    const peer = this.peer
    const child = this.child
    if (peer !== undefined) {
      await peer.request(arpMethods.shutdown, {}, { timeoutMs: 2_000 }).catch(() => undefined)
      peer.dispose()
    }
    if (child?.pid !== undefined) await killTree(child.pid).catch(() => undefined)
    this.peer = undefined
    this.child = undefined
    this.setState('stopped')
  }

  private startHeartbeat(): void {
    this.stopHeartbeat()
    const interval = this.o.heartbeatMs ?? 0
    if (interval <= 0) return
    this.heartbeatTimer = setInterval(() => {
      if (this.pinging || this.peer === undefined || this.state !== 'ready') return
      this.pinging = true
      void this.peer
        .request(arpMethods.ping, {}, { timeoutMs: this.o.heartbeatTimeoutMs ?? 2_000 })
        .then(
          () => undefined,
          async () => {
            this.lastError = 'Runtime Worker 心跳失败'
            await this.kill()
            if (this.o.autoRestart !== true) this.setState('failed')
          },
        )
        .finally(() => {
          this.pinging = false
        })
    }, interval)
    this.heartbeatTimer.unref?.()
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer !== undefined) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = undefined
    }
  }

  private scheduleRestart(): void {
    const windowMs = this.o.restartWindowMs ?? 60_000
    if (Date.now() - this.readyAt > windowMs) this.attempts = 0
    this.attempts += 1
    const backoff = this.o.backoffMs ?? [500, 1_000, 2_000, 4_000, 8_000]
    const delay = backoff[Math.min(this.attempts - 1, backoff.length - 1)] ?? 8_000
    this.setState('restarting')
    this.restartTimer = setTimeout(() => {
      this.restartTimer = undefined
      void this.start().catch((error: unknown) => {
        this.lastError = error instanceof Error ? error.message : String(error)
        this.setState('failed')
      })
    }, delay)
  }

  /** 模拟崩溃/强杀：只杀进程树，不写 stopped；退出回调会把状态标成 failed。 */
  async kill(): Promise<void> {
    const pid = this.child?.pid
    if (pid !== undefined) await killTree(pid).catch(() => undefined)
  }

  async restart(): Promise<void> {
    await this.stop()
    this.setState('idle')
    await this.start()
  }
}
