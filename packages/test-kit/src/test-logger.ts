import type { Logger, LogLevel } from '@poietica/foundation'

export interface TestLogRecord {
  readonly level: LogLevel
  readonly msg: string
  readonly data: Readonly<Record<string, unknown>>
}

export interface TestLogger extends Logger {
  /** 本 logger 及其全部 child 写出的记录（共享同一个数组） */
  readonly records: TestLogRecord[]
  /** 某个级别的记录 */
  at(level: LogLevel): TestLogRecord[]
}

/**
 * 收集日志而不输出。默认不打印；设置环境变量 POIETICA_TEST_LOG=1 时同时打印到控制台（排查失败用例）。
 * console 是测试环境的唯一输出通道，这个文件在 biome.json 里按精确路径豁免 noConsole。
 */
export function createTestLogger(): TestLogger {
  const records: TestLogRecord[] = []
  const verbose = process.env.POIETICA_TEST_LOG === '1'
  const make = (bindings: Readonly<Record<string, unknown>>): TestLogger => {
    const emit = (level: LogLevel, msg: string, data?: Record<string, unknown>): void => {
      const record = { level, msg, data: { ...bindings, ...(data ?? {}) } }
      records.push(record)
      if (verbose) console.log(`[${level}] ${msg}`, record.data)
    }
    return {
      records,
      at: (level) => records.filter((r) => r.level === level),
      debug: (msg, data) => emit('debug', msg, data),
      info: (msg, data) => emit('info', msg, data),
      warn: (msg, data) => emit('warn', msg, data),
      error: (msg, data) => emit('error', msg, data),
      child: (more) => make({ ...bindings, ...more }),
    }
  }
  return make({})
}
