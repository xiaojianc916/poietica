import type { Disposable, Event } from '@poietica/foundation'
import { AppError, SystemErrorCode } from '@poietica/foundation'
import { jsonValue } from '@poietica/rpc'
import type {
  AgentEngine,
  CommandCatalogOptions,
  Controls,
  DraftControlInit,
  EngineInfo,
  EngineSession,
  EngineToolSpec,
  LoginIO,
  OpenSessionSpec,
  SlashCommand,
} from '@poietica/runtime-protocol'
import {
  arpEngineSnapshotResult,
  arpLoginAuthParams,
  arpLoginProgressParams,
  arpLoginPromptParams,
  arpMethods,
  arpPortEventMethod,
  arpPortEventParams,
  arpToolExecuteParams,
} from '@poietica/runtime-protocol'
import { z } from 'zod'
import { type RuntimeLaunch, RuntimeProcess, type RuntimeProcessOptions } from './runtime-process'
import { ArpSession } from './session'

/**
 * ARP 版的 AgentEngine：Core 只依赖这一层，进程里不再 import engine-omp。
 * 会话走 ArpSession；ports 走 engine.call 的通用路径；产品工具的反向执行桥在后续接。
 * 事件订阅（onDidChange）暂为无操作，Worker 侧的变更广播随后补。
 */
export class ArpEngine implements AgentEngine {
  readonly info: EngineInfo
  private readonly sessions = new Map<string, ArpSession>()

  private readonly snapshot: ReturnType<typeof arpEngineSnapshotResult.parse>
  private freeze: Promise<unknown> | undefined
  private disposed = false
  private portSubscription: { dispose(): void } | undefined
  private readonly portListeners = new Map<string, Set<(data: unknown) => void>>()
  private readonly logins = new Map<string, LoginIO>()
  private readonly specs = new Map<string, OpenSessionSpec>()
  private recovering = false

  private constructor(
    private readonly runtime: RuntimeProcess,
    info: EngineInfo,
    snapshot: ReturnType<typeof arpEngineSnapshotResult.parse>,
    private readonly tools: Map<string, EngineToolSpec>,
  ) {
    this.info = info
    this.snapshot = snapshot
  }

  static async connect(o: {
    launch: RuntimeLaunch
    logger: RuntimeProcessOptions['logger']
    readyTimeoutMs?: number
    onError?: (error: unknown) => void
  }): Promise<ArpEngine> {
    const tools = new Map<string, EngineToolSpec>()
    let engineRef: ArpEngine | undefined
    const runtime = new RuntimeProcess({
      launch: o.launch,
      logger: o.logger,
      autoRestart: true,
      ...(o.readyTimeoutMs === undefined ? {} : { readyTimeoutMs: o.readyTimeoutMs }),
      onState: (status) => {
        if (status.state === 'restarting' || status.state === 'failed') engineRef?.markInterrupted()
        if (status.state === 'ready') void engineRef?.recoverSessions()
      },
      onRequest: async (method, rawParams) => {
        const params = jsonValue(rawParams)
        const login = await handleLoginRequest(method, params, () => engineRef?.logins)
        if (login.handled) return login.value
        if (method === arpMethods.toolExecute) {
          const input = arpToolExecuteParams.parse(params)
          const spec = tools.get(input.name)
          if (spec === undefined) throw new AppError(SystemErrorCode.notFound, `未知产品工具：${input.name}`)
          const result = await spec.execute(input.params as never, {
            cwd: input.cwd,
            sessionKey: input.sessionKey,
            signal: new AbortController().signal,
          })
          return {
            text: result.text,
            ...(result.details === undefined ? {} : { details: result.details }),
            ...(result.isError === undefined ? {} : { isError: result.isError }),
          }
        }
        throw new AppError(SystemErrorCode.methodNotFound, `未知 Worker 反向方法 ${method}`)
      },
    })
    await runtime.start()
    const hello = runtime.hello
    if (hello === null) throw new AppError(SystemErrorCode.coreUnavailable, 'Runtime Worker 没有 hello')
    const snapshot = arpEngineSnapshotResult.parse(await runtime.request(arpMethods.engineSnapshot, {}))
    const engine = new ArpEngine(runtime, { name: 'omp', version: hello.engineVersion }, snapshot, tools)
    engineRef = engine
    engine.portSubscription = runtime.onNotification((method, params) => {
      if (method === arpPortEventMethod) engine.onPortEvent(params)
    })
    return engine
  }

  async openSession(spec: OpenSessionSpec): Promise<EngineSession> {
    await this.freeze
    const session = await ArpSession.open({
      spec,
      request: (method, params, timeoutMs) => this.runtime.request(method, params, timeoutMs),
      onError: () => undefined,
    })
    /* 首次打开的会话文件要记下来：Worker 重启后按同一份文件恢复。 */
    this.specs.set(spec.key, { ...spec, sessionFile: session.sessionFile })
    this.sessions.set(spec.key, session)
    return session
  }

  draftControls(init?: DraftControlInit): Promise<Controls> {
    return this.call(['draftControls'], [init]) as Promise<Controls>
  }

  commandCatalog(cwd: string | null, options?: CommandCatalogOptions): Promise<readonly SlashCommand[]> {
    return this.call(['commandCatalog'], [cwd, options]) as Promise<readonly SlashCommand[]>
  }

  registerTool(spec: EngineToolSpec): Disposable {
    this.tools.set(spec.name, spec)
    void this.runtime.request(arpMethods.engineRegisterTool, {
      name: spec.name,
      label: spec.label,
      description: spec.description,
      parametersJsonSchema: z.toJSONSchema(spec.parameters),
      approval: spec.approval,
      ...(spec.streamInput === undefined ? {} : { streamInput: spec.streamInput }),
    })
    return {
      dispose: () => {
        this.tools.delete(spec.name)
        void this.runtime.request(arpMethods.engineUnregisterTool, { name: spec.name })
      },
    }
  }

  freezeTools(): void {
    this.freeze ??= this.call(['freezeTools'], [])
  }

  get sessionFiles(): AgentEngine['sessionFiles'] {
    return this.port('sessionFiles') as AgentEngine['sessionFiles']
  }
  get models(): AgentEngine['models'] {
    const base = this.port('models') as AgentEngine['models']
    return new Proxy(base, {
      get: (target, prop, receiver) =>
        prop === 'login'
          ? (providerId: string, io: LoginIO) => this.login(providerId, io)
          : Reflect.get(target, prop, receiver),
    })
  }
  get settings(): AgentEngine['settings'] {
    const proxy = this.port('settings') as AgentEngine['settings']
    return new Proxy(proxy, {
      get: (target, prop, receiver) =>
        prop === 'groupOrder' ? this.snapshot.groupOrder : Reflect.get(target, prop, receiver),
    })
  }
  get skills(): AgentEngine['skills'] {
    return this.port('skills') as AgentEngine['skills']
  }
  get mcp(): AgentEngine['mcp'] {
    return this.port('mcp') as AgentEngine['mcp']
  }
  get plugins(): AgentEngine['plugins'] {
    return this.port('plugins') as AgentEngine['plugins']
  }

  browserRelay(): ReturnType<AgentEngine['browserRelay']> {
    return this.snapshot.browserRelay as ReturnType<AgentEngine['browserRelay']>
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    await Promise.all([...this.sessions.values()].map((session) => session.dispose()))
    this.sessions.clear()
    this.specs.clear()
    this.portSubscription?.dispose()
    await this.runtime.stop()
  }

  private call(path: readonly string[], args: readonly unknown[]): Promise<unknown> {
    return this.runtime.request(arpMethods.engineCall, { path, args: cleanArgs(args) })
  }

  private markInterrupted(): void {
    for (const session of this.sessions.values()) {
      session.dispatch({
        type: 'state',
        state: 'idle',
        error: { code: 'runtime.worker_exited', message: '运行时已重启，正在恢复会话' },
      })
    }
  }

  private async recoverSessions(): Promise<void> {
    if (this.recovering || this.specs.size === 0) return
    this.recovering = true
    try {
      for (const [key, spec] of this.specs) {
        try {
          const fresh = await ArpSession.open({
            spec,
            request: (method, params, timeoutMs) => this.runtime.request(method, params, timeoutMs),
            onError: () => undefined,
          })
          const held = this.sessions.get(key)
          if (held === undefined) this.sessions.set(key, fresh)
          else held.rebind(fresh)
        } catch {
          /* 单条恢复失败：保留 interrupted 状态，下一次发言会重新打开。 */
        }
      }
    } finally {
      this.recovering = false
    }
  }

  private async login(providerId: string, io: LoginIO): Promise<Awaited<ReturnType<AgentEngine['models']['login']>>> {
    const loginId = crypto.randomUUID()
    this.logins.set(loginId, io)
    const cancel = (): void => {
      void this.runtime.request(arpMethods.loginCancel, { loginId }).catch(() => undefined)
    }
    io.signal.addEventListener('abort', cancel, { once: true })
    try {
      return (await this.runtime.request(arpMethods.modelsLogin, { providerId, loginId }, 0)) as Awaited<
        ReturnType<AgentEngine['models']['login']>
      >
    } finally {
      io.signal.removeEventListener('abort', cancel)
      this.logins.delete(loginId)
    }
  }

  private onPortEvent(params: unknown): void {
    const parsed = arpPortEventParams.safeParse(params)
    if (!parsed.success) return
    const key = `${parsed.data.port}:${parsed.data.event}`
    for (const listener of this.portListeners.get(key) ?? []) listener(parsed.data.data)
  }

  private portEvent(name: string, event: string): Event<never> {
    const key = `${name}:${event}`
    return (listener) => {
      const listeners = this.portListeners.get(key) ?? new Set<(data: unknown) => void>()
      listeners.add(listener as (data: unknown) => void)
      this.portListeners.set(key, listeners)
      return { dispose: () => listeners.delete(listener as (data: unknown) => void) }
    }
  }

  private port(name: string): object {
    return new Proxy(
      {},
      {
        get: (_target, prop) => {
          if (typeof prop !== 'string') return undefined
          if (prop === 'onDidChange') return this.portEvent(name, 'change')
          if (prop === 'onDidChangeDefaults') return this.portEvent(name, 'defaults')
          if (prop === 'onDidChangeStatus') return this.portEvent(name, 'status')
          return (...args: unknown[]) => this.call([name, prop], args)
        },
      },
    )
  }
}

function cleanArgs(args: readonly unknown[]): unknown[] {
  return args.map((arg) => (typeof arg === 'function' || arg instanceof AbortSignal ? undefined : arg))
}

async function handleLoginRequest(
  method: string,
  params: unknown,
  logins: () => Map<string, LoginIO> | undefined,
): Promise<{ handled: boolean; value?: unknown }> {
  if (method === arpMethods.loginAuth) {
    const input = arpLoginAuthParams.parse(params)
    logins()?.get(input.loginId)?.onAuth(input.info)
    return { handled: true, value: {} }
  }
  if (method === arpMethods.loginProgress) {
    const input = arpLoginProgressParams.parse(params)
    logins()?.get(input.loginId)?.onProgress(input.message)
    return { handled: true, value: {} }
  }
  if (method === arpMethods.loginPrompt) {
    const input = arpLoginPromptParams.parse(params)
    const io = logins()?.get(input.loginId)
    if (io === undefined) throw new AppError(SystemErrorCode.notFound, '登录会话不存在')
    return { handled: true, value: { value: await io.onPrompt(input.prompt) } }
  }
  return { handled: false }
}
