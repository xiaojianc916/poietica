import { z } from 'zod'

/** 应用错误。code 形如 '<命名空间>.<snake_case>'，例如 'kernel.not_found'、'terminal.spawn_failed'。 */
export class AppError extends Error {
  override readonly name = 'AppError'
  constructor(
    readonly code: string,
    message: string,
    readonly data?: Readonly<Record<string, unknown>>,
  ) {
    super(message)
  }
  toJSON(): SerializedAppError {
    return { code: this.code, message: this.message, ...(this.data === undefined ? {} : { data: this.data }) }
  }
}

export const SerializedAppError = z.object({
  code: z.string(),
  message: z.string(),
  data: z.record(z.string(), z.unknown()).optional(),
})
export type SerializedAppError = z.infer<typeof SerializedAppError>

export function isAppError(value: unknown): value is AppError {
  return value instanceof AppError
}

/** 把任意异常规整为 AppError。未知异常归为 kernel.internal，原始 message 保留，stack 不外传。 */
export function toAppError(error: unknown): AppError {
  if (error instanceof AppError) return error
  if (error instanceof Error) return new AppError(SystemErrorCode.internal, error.message)
  return new AppError(SystemErrorCode.internal, String(error))
}

/** 系统级错误码（命名空间 kernel）。功能级错误码由各功能在 contract 中用 defineErrors 定义。 */
export const SystemErrorCode = {
  invalidParams: 'kernel.invalid_params',
  methodNotFound: 'kernel.method_not_found',
  notFound: 'kernel.not_found',
  conflict: 'kernel.conflict',
  cancelled: 'kernel.cancelled',
  timeout: 'kernel.timeout',
  coreUnavailable: 'kernel.core_unavailable',
  coreRestarted: 'kernel.core_restarted',
  dataRootInvalid: 'kernel.data_root_invalid',
  moduleGraphInvalid: 'kernel.module_graph_invalid',
  unhandledMethod: 'kernel.unhandled_method',
  serviceAccessDenied: 'kernel.service_access_denied',
  tableAccessDenied: 'kernel.table_access_denied',
  protocolMismatch: 'kernel.protocol_mismatch',
  contractInvalid: 'kernel.contract_invalid',
  io: 'kernel.io_error',
  internal: 'kernel.internal',
} as const
export type SystemErrorCode = (typeof SystemErrorCode)[keyof typeof SystemErrorCode]
