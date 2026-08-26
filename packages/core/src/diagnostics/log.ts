import { recordDiagnosticLog } from './buffer'

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error'

export interface LogContext {
  readonly scope?: string
  readonly correlationId?: string
  readonly [key: string]: unknown
}

export type LogSink = (
  level: LogLevel,
  message: string,
  context: LogContext,
  timestamp: string,
) => void

let sink: LogSink = defaultConsoleSink

/** 控制台只收 warn 与 error。其余级别留在诊断缓冲里，导出诊断时才读。 */
function defaultConsoleSink(
  level: LogLevel,
  message: string,
  context: LogContext,
  timestamp: string,
): void {
  if (level !== 'warn' && level !== 'error') {
    return
  }

  const prefix = context.scope ? `[${context.scope}]` : ''
  const formatted = [timestamp, level.toUpperCase(), prefix, message].filter(Boolean).join(' ')

  if (level === 'warn') {
    console.warn(formatted, context)
    return
  }

  console.error(formatted, context)
}

export function setLogSink(next: LogSink): void {
  sink = next
}

export function log(level: LogLevel, message: string, context: LogContext = {}): void {
  const timestamp = new Date().toISOString()

  recordDiagnosticLog(level, message, context, timestamp)

  try {
    sink(level, message, context, timestamp)
  } catch (cause: unknown) {
    // 日志本身不许升级成致命错误。
    console.error('[Poietica] log sink failed', { level, message, cause })
  }
}

export function warn(message: string, context?: LogContext): void {
  log('warn', message, context)
}

export function error(message: string, context?: LogContext): void {
  log('error', message, context)
}
