import type { Disposable, Event } from '@poietica/foundation'
import { AppError, SystemErrorCode } from '@poietica/foundation'
import type {
  AgentEngine,
  CommandCatalogOptions,
  Controls,
  DraftControlInit,
  EngineInfo,
  EngineSession,
  EngineToolSpec,
  OpenSessionSpec,
  SlashCommand,
} from '@poietica/runtime-protocol'
import { arpEngineSnapshotResult, arpMethods } from '@poietica/runtime-protocol'
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

  private constructor(
    private readonly runtime: RuntimeProcess,
    info: EngineInfo,
    snapshot: ReturnType<typeof arpEngineSnapshotResult.parse>,
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
    const runtime = new RuntimeProcess({
      launch: o.launch,
      logger: o.logger,
      ...(o.readyTimeoutMs === undefined ? {} : { readyTimeoutMs: o.readyTimeoutMs }),
    })
    await runtime.start()
    const hello = runtime.hello
    if (hello === null) throw new AppError(SystemErrorCode.coreUnavailable, 'Runtime Worker 没有 hello')
    const snapshot = arpEngineSnapshotResult.parse(await runtime.request(arpMethods.engineSnapshot, {}))
    return new ArpEngine(runtime, { name: 'omp', version: hello.engineVersion }, snapshot)
  }

  async openSession(spec: OpenSessionSpec): Promise<EngineSession> {
    await this.freeze
    const session = await ArpSession.open({
      spec,
      request: (method, params, timeoutMs) => this.runtime.request(method, params, timeoutMs),
      onError: () => undefined,
    })
    this.sessions.set(spec.key, session)
    return session
  }

  draftControls(init?: DraftControlInit): Promise<Controls> {
    return this.call(['draftControls'], [init]) as Promise<Controls>
  }

  commandCatalog(cwd: string | null, options?: CommandCatalogOptions): Promise<readonly SlashCommand[]> {
    return this.call(['commandCatalog'], [cwd, options]) as Promise<readonly SlashCommand[]>
  }

  registerTool(_spec: EngineToolSpec): Disposable {
    throw new AppError('runtime.tool_bridge_missing', '产品工具 ARP 桥尚未接入')
  }

  freezeTools(): void {
    this.freeze ??= this.call(['freezeTools'], [])
  }

  get sessionFiles(): AgentEngine['sessionFiles'] {
    return this.port('sessionFiles') as AgentEngine['sessionFiles']
  }
  get models(): AgentEngine['models'] {
    return this.port('models') as AgentEngine['models']
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
    await this.runtime.stop()
  }

  private call(path: readonly string[], args: readonly unknown[]): Promise<unknown> {
    return this.runtime.request(arpMethods.engineCall, { path, args: cleanArgs(args) })
  }

  private port(name: string): object {
    return new Proxy(
      {},
      {
        get: (_target, prop) => {
          if (typeof prop !== 'string') return undefined
          if (prop.startsWith('onDidChange') || prop === 'onDidChangeStatus') {
            const event: Event<never> = () => ({ dispose: () => undefined })
            return event
          }
          return (...args: unknown[]) => this.call([name, prop], args)
        },
      },
    )
  }
}

function cleanArgs(args: readonly unknown[]): unknown[] {
  return args.map((arg) => (typeof arg === 'function' || arg instanceof AbortSignal ? undefined : arg))
}
