import type {
  Contract,
  MethodName,
  NotificationName,
  NotificationParams,
  ParamsIn,
  ResultOf,
} from '@poietica/contract-kit'
import {
  type Disposable,
  type DisposableStore,
  defineServiceToken,
  KERNEL_OWNER,
  type Logger,
  type ModuleServices,
  type ServiceToken,
} from '@poietica/foundation'
import type { DataLayout } from '@poietica/runtime-layout'
import type { AssetHandler } from './asset-protocol'
import type { CoreStatus } from './core-supervisor'
import type { QuitOptions } from './quit'
import type { HostRpcBinding } from './rpc-binding'
import type { WindowRegistry } from './windows'

export interface HostModule<C extends Contract = Contract> {
  readonly id: string
  readonly contract?: C
  readonly dependsOn?: readonly string[]
  setup(ctx: HostModuleContext<C>): void | Promise<void>
}

export interface CoreCaller {
  /** 调用 owner='core' 的方法。Core 未就绪时排队（最多 30 秒），与 UI 的请求走同一条路径 */
  call<C extends Contract, N extends MethodName<C>>(
    contract: C,
    name: N,
    params: ParamsIn<C, N>,
    opts?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<ResultOf<C, N>>
  /** 订阅 Core 发出的通知（Host 模块旁听；通知照常广播给窗口） */
  on<C extends Contract, N extends NotificationName<C>>(
    contract: C,
    name: N,
    listener: (params: NotificationParams<C, N>) => void,
  ): Disposable
  readonly status: () => CoreStatus
  onStatus(listener: (status: CoreStatus) => void): Disposable
  /** 当前（或最近一次）Core 进程使用的浏览器 relay 端口；Core 从未启动过时为 null */
  relayPort(): number | null
}

export interface HostModuleContext<C extends Contract = Contract> {
  readonly moduleId: string
  readonly logger: Logger
  readonly layout: DataLayout
  readonly isPackaged: boolean
  readonly appVersion: string
  /** 应用资源目录（安装后为 process.resourcesPath；开发时为 apps/desktop/resources） */
  readonly resourcesDir: string
  readonly rpc: HostRpcBinding<C>
  readonly core: CoreCaller
  readonly windows: WindowRegistry
  /** 在 poietica-asset://<host>/... 下注册一个子路径处理器，例如 attachments 注册 host='attachment' */
  readonly assets: { register(host: string, handler: AssetHandler): void }
  readonly services: ModuleServices
  readonly app: {
    /** 走完整退出流程。任何模块都可以调用，例如 platform 的 app.quit 方法、update 的安装更新 */
    quit(opts?: QuitOptions): Promise<void>
    readonly quitting: () => boolean
  }
  readonly lifecycle: {
    /** 主窗口创建之前执行，例如根据主题设置窗口底色、恢复窗口位置 */
    beforeWindow(fn: () => void | Promise<void>): void
    /** 主窗口创建之后、Core 启动之前执行 */
    onReady(fn: () => void | Promise<void>): void
    /** 退出时逆序执行，每个最多 5 秒 */
    onShutdown(fn: () => void | Promise<void>): void
  }
  readonly disposables: DisposableStore
}

export function defineHostModule<C extends Contract>(m: HostModule<C>): HostModule<C> {
  return m
}

/** 内核服务：日志级别。preferences 的 host 模块在启动与偏好变化时调用 setLevel；CoreSupervisor 启动 Core 时读取 level */
export interface HostLogging {
  level(): 'debug' | 'info' | 'warn' | 'error'
  setLevel(level: 'debug' | 'info' | 'warn' | 'error'): void
}
export const HostLoggingToken: ServiceToken<HostLogging> = defineServiceToken<HostLogging>(KERNEL_OWNER, 'HostLogging')
