import type { UiFeatureContext } from '@poietica/ui-kernel'
import { type UpdateState, updateContract } from '../contract'

/**
 * `ctx.rpc(updateContract)` 的薄封装（07 页 §15E）。
 *
 * 四个方法都在 Host（更新器只能住在主进程：electron-updater 要 app、process.resourcesPath
 * 与安装包），UI 只做「读状态 / 发动作」。
 */
export function createUpdateApi(ctx: UiFeatureContext) {
  const rpc = ctx.rpc(updateContract)

  return {
    state: (): Promise<UpdateState> => rpc.call('update.state', {}),
    check: (): Promise<UpdateState> => rpc.call('update.check', {}),
    download: (): Promise<UpdateState> => rpc.call('update.download', {}),
    install: (): Promise<UpdateState> => rpc.call('update.install', {}),
    onStateChanged: (listener: (state: UpdateState) => void) => rpc.on('update.stateChanged', listener),
  }
}

export type UpdateApi = ReturnType<typeof createUpdateApi>
