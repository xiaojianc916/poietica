import type { Contract } from '@poietica/contract-kit'
import type { Disposable, Logger, ModuleServices } from '@poietica/foundation'
import type { TypedRpcClient } from '@poietica/rpc'
import type { ContributionPoint } from './contribution'

export interface UiFeature {
  readonly id: string
  readonly dependsOn?: readonly string[]
  setup(ctx: UiFeatureContext): void
}

export interface UiFeatureContext {
  readonly featureId: string
  readonly logger: Logger
  /** 只能传入本功能或 dependsOn 中功能的契约（例如 workspaces 选文件夹要用 platform 的 dialog.pickFolder，就要 dependsOn: ['platform']） */
  rpc<C extends Contract>(contract: C): TypedRpcClient<C>
  readonly services: ModuleServices
  contribute<T>(point: ContributionPoint<T>, item: T): Disposable
  /** 拖放/粘贴文件 → 本地路径（只有 attachments 用得到） */
  readonly files: { pathForFile(file: File): string }
  readonly lifecycle: {
    /** Core 每次进入 ready（首次启动、崩溃重启后、手动重启后）都调用：在这里（重新）拉取数据、重新订阅 */
    onCoreReady(fn: () => void | Promise<void>): void
    /**
     * Core 从 ready 变为非 ready（restarting / failed / stopped）时**同步**调用。
     *
     * 用来清掉「依赖 Core 进程内状态」的本地缓存（例如 UI 侧的运行态）。同步执行是
     * 有意的：它必须在新 Core 的任何通知被处理之前完成 —— 新进程的通知只会在 Host 收到
     * `core.ready` 之后到达，而 `restarting` 状态的广播一定早于新进程启动。
     * 这里**不能**发任何 RPC：那一刻 Core 不可用，请求会排队到超时。
     */
    onCoreLost(fn: () => void): void
    onDispose(fn: () => void): void
  }
}

export function defineUiFeature(f: UiFeature): UiFeature {
  return f
}
