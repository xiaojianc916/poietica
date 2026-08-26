import { recordDiagnosticLog } from './buffer'

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error'

export interface LogContext {
  readonly scope?: string
  readonly correlationId?: string
  readonly [key: string]: unknown
}

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

export function log(level: LogLevel, message: string, context: LogContext = {}): void {
  const timestamp = new Date().toISOString()

  recordDiagnosticLog(level, message, context, timestamp)
  defaultConsoleSink(level, message, context, timestamp)
}

export function warn(message: string, context?: LogContext): void {
  log('warn', message, context)
}

export function error(message: string, context?: LogContext): void {
  log('error', message, context)
}
