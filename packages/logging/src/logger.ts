import type { Clock, Logger, LogLevel } from '@poietica/foundation'

export type LogRecord = Readonly<Record<string, unknown>> & {
  readonly ts: number
  readonly level: LogLevel
  readonly msg: string
}

export interface LogSink {
  /** 写一条记录。实现负责脱敏（redactSecrets）并且不得抛错 */
  write(record: Readonly<Record<string, unknown>>): void
}

const ORDER: Readonly<Record<LogLevel, number>> = { debug: 10, info: 20, warn: 30, error: 40 }
const RESERVED = new Set(['ts', 'level', 'msg'])

export interface CreateLoggerOptions {
  /** 当前级别；传函数时每次写日志都读取一次，便于运行时调整级别而不重建 logger */
  readonly level: LogLevel | (() => LogLevel)
  readonly sinks: readonly LogSink[]
  /** 每条记录都带的字段，例如 { proc: 'host' } */
  readonly base?: Readonly<Record<string, unknown>>
  readonly clock?: Pick<Clock, 'now'>
}

export function createLogger(o: CreateLoggerOptions): Logger {
  const levelOf = typeof o.level === 'function' ? o.level : (): LogLevel => o.level as LogLevel
  const now = o.clock?.now ?? (() => Date.now())
  const make = (bindings: Readonly<Record<string, unknown>>): Logger => {
    const emit = (level: LogLevel, msg: string, data: Record<string, unknown> | undefined): void => {
      if (ORDER[level] < ORDER[levelOf()]) return
      const record: Record<string, unknown> = { ts: now(), level }
      for (const [k, v] of Object.entries(bindings)) if (!RESERVED.has(k)) record[k] = v
      record.msg = msg
      if (data !== undefined) for (const [k, v] of Object.entries(data)) if (!RESERVED.has(k)) record[k] = v
      for (const sink of o.sinks) {
        try {
          sink.write(record)
        } catch {
          // sink 约定不抛错；万一抛了也不能让日志打断业务
        }
      }
    }
    return {
      debug: (msg, data) => emit('debug', msg, data),
      info: (msg, data) => emit('info', msg, data),
      warn: (msg, data) => emit('warn', msg, data),
      error: (msg, data) => emit('error', msg, data),
      child: (more) => make({ ...bindings, ...more }),
    }
  }
  return make({ ...(o.base ?? {}) })
}
