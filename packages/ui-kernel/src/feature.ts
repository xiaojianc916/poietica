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
    onDispose(fn: () => void): void
  }
}

export function defineUiFeature(f: UiFeature): UiFeature {
  return f
}
