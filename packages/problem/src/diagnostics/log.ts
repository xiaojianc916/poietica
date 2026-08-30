import { recordDiagnosticLog } from './buffer'

export type LogLevel = 'warn' | 'error'

export interface LogContext {
  readonly scope?: string
  readonly correlationId?: string
  readonly [key: string]: unknown
}

function defaultConsoleSink(
  level: LogLevel,
  message: string,
  context: LogContext,
  timestamp: string,
): void {
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
