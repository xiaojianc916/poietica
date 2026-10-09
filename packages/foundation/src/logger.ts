export type LogLevel = 'debug' | 'info' | 'warn' | 'error'
export const LOG_LEVELS: readonly LogLevel[] = ['debug', 'info', 'warn', 'error']

/** 日志接口。实现在 @poietica/logging。msg 用英文短语，data 放结构化字段 */
export interface Logger {
  debug(msg: string, data?: Record<string, unknown>): void
  info(msg: string, data?: Record<string, unknown>): void
  warn(msg: string, data?: Record<string, unknown>): void
  error(msg: string, data?: Record<string, unknown>): void
  /** 派生一个带固定字段的子 logger，例如 logger.child({ module: 'conversation' }) */
  child(bindings: Record<string, unknown>): Logger
}

export const noopLogger: Logger = Object.freeze({
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => noopLogger,
})
