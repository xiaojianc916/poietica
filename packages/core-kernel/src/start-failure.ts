import { isAppError, SystemErrorCode } from '@poietica/foundation'
import { CORE_EXIT_CODES } from '@poietica/runtime-layout'
import { DataTooNewError, MigrationError } from '@poietica/storage-sqlite'

/**
 * 内核启动失败 → Core 退出码（R-08-8）。从前所有启动失败都以退出码 1 退出，Host 把确定性失败
 * 也退避重启五轮、最后报成 crash_loop —— 重试不会改变结果，还拿不到真正的原因。判据只用错误
 * 类型与 code：数据库比程序新 → `dataTooNew`；迁移 / 装配期失败 → `startFailed`；
 * 其余（打不开库、端口、宿主 IO……）仍按 `crashed` 走退避，那些有可能自愈。
 */
export function coreStartFailureExitCode(error: unknown): number {
  if (error instanceof DataTooNewError) return CORE_EXIT_CODES.dataTooNew
  if (error instanceof MigrationError) return CORE_EXIT_CODES.startFailed

  if (isAppError(error)) {
    const code: string = error.code
    if (
      code === SystemErrorCode.moduleGraphInvalid ||
      code === SystemErrorCode.unhandledMethod ||
      code === SystemErrorCode.contractInvalid ||
      code === SystemErrorCode.tableAccessDenied
    ) {
      return CORE_EXIT_CODES.startFailed
    }
  }

  return CORE_EXIT_CODES.crashed
}
