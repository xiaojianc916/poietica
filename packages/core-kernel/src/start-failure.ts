import { isAppError, SystemErrorCode } from '@poietica/foundation'
import { CORE_EXIT_CODES } from '@poietica/runtime-layout'
import { DataTooNewError, MigrationError } from '@poietica/storage-sqlite'

/**
 * 内核启动失败 → Core 退出码（R-08-8）。
 *
 * 从前所有启动失败都以退出码 1 退出，于是 Host 只认得「崩溃」，把确定性失败也退避重启
 * 五轮，最后报成 `crash_loop`（UI 文案：「Agent 引擎反复崩溃」）—— 用户既等了一轮
 * 没意义的重试，也拿不到真正的原因。这里把「重试不会改变结果」的那几类分出来。
 *
 * 判据只用错误类型与 code，不认识具体功能：
 * - 数据库比程序新（降级安装）→ `dataTooNew`，只能装回新版本；
 * - 迁移脚本本身失败、模块图不合法、有方法没实现、契约没汇总 → `startFailed`；
 * - 其余（打不开库、端口、宿主 IO……）仍按 `crashed` 走退避，那些有可能自愈。
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
