import { describe, expect, test } from 'bun:test'
import { AppError, SystemErrorCode } from '@poietica/foundation'
import { CORE_EXIT_CODES } from '@poietica/runtime-layout'
import { DataTooNewError, MigrationError } from '@poietica/storage-sqlite'
import { coreStartFailureExitCode } from '../start-failure'

/*
 * R-08-8：启动失败的退出码分类。
 *
 * 从前所有启动失败一律退出码 1，Host 把它当崩溃退避五轮，最后报成 crash_loop（界面文案
 * 「Agent 引擎反复崩溃」）。数据库比程序新这种情况重试再多次也读不进去，必须给它一个
 * 专属码，让 Host 一步进 failed/data_too_new。
 */
describe('启动失败 → Core 退出码（R-08-8）', () => {
  test('数据库来自更新的版本 → 4', () => {
    expect(coreStartFailureExitCode(new DataTooNewError('数据库来自更新的 Poietica 版本'))).toBe(
      CORE_EXIT_CODES.dataTooNew,
    )
  })

  test('其余迁移错误（脚本本身失败）→ 5', () => {
    expect(coreStartFailureExitCode(new MigrationError('迁移脚本炸了'))).toBe(CORE_EXIT_CODES.startFailed)
  })

  test('模块图 / 未实现方法 / 契约无效 → 5；打不开数据库等仍旧走崩溃重试', () => {
    expect(coreStartFailureExitCode(new AppError(SystemErrorCode.moduleGraphInvalid, '成环'))).toBe(
      CORE_EXIT_CODES.startFailed,
    )
    expect(coreStartFailureExitCode(new AppError(SystemErrorCode.unhandledMethod, '缺方法'))).toBe(
      CORE_EXIT_CODES.startFailed,
    )
    expect(coreStartFailureExitCode(new AppError(SystemErrorCode.contractInvalid, '契约坏了'))).toBe(
      CORE_EXIT_CODES.startFailed,
    )
    /* 打不开数据库 / 未知异常仍按崩溃：它们可能是暂时的（占用、权限刚变） */
    expect(coreStartFailureExitCode(new AppError(SystemErrorCode.io, '被占用'))).toBe(CORE_EXIT_CODES.crashed)
    expect(coreStartFailureExitCode(new Error('未知'))).toBe(CORE_EXIT_CODES.crashed)
    expect(coreStartFailureExitCode('not-an-error')).toBe(CORE_EXIT_CODES.crashed)
  })
})
