import { describe, expect, test } from 'bun:test'
import type { LogLevel } from '@poietica/foundation'
import { createLogger, type LogSink } from '../logger'

/** 把记录收进数组的 sink */
function collectingSink(into: Array<Readonly<Record<string, unknown>>>): LogSink {
  return {
    write(record) {
      into.push(record)
    },
  }
}

describe('createLogger', () => {
  test('level 为 info 时 debug 被丢弃', () => {
    const records: Array<Readonly<Record<string, unknown>>> = []
    const logger = createLogger({ level: 'info', sinks: [collectingSink(records)] })
    logger.debug('d')
    logger.info('i')
    logger.warn('w')
    logger.error('e')
    expect(records.map((r) => r.level)).toEqual(['info', 'warn', 'error'])
  })

  test('level 传函数时每次写日志都重新读取', () => {
    let level: LogLevel = 'warn'
    const records: Array<Readonly<Record<string, unknown>>> = []
    const logger = createLogger({ level: () => level, sinks: [collectingSink(records)] })
    logger.info('hidden')
    expect(records).toHaveLength(0)
    level = 'debug'
    logger.debug('shown')
    expect(records.map((r) => r.msg)).toEqual(['shown'])
  })

  test('child 的绑定字段合并，键顺序为 ts, level, …绑定, msg, …data', () => {
    const records: Array<Readonly<Record<string, unknown>>> = []
    const logger = createLogger({ level: 'debug', base: { proc: 'test' }, sinks: [collectingSink(records)] })
    logger.child({ module: 'x' }).child({ scope: 'y' }).info('hello', { a: 1 })
    expect(records).toHaveLength(1)
    const record = records[0]
    expect(record?.module).toBe('x')
    expect(record?.scope).toBe('y')
    expect(record?.proc).toBe('test')
    expect(Object.keys(record ?? {})).toEqual(['ts', 'level', 'proc', 'module', 'scope', 'msg', 'a'])
  })

  test('data 里的保留字段不覆盖 ts/level/msg', () => {
    const records: Array<Readonly<Record<string, unknown>>> = []
    const logger = createLogger({ level: 'debug', clock: { now: () => 123 }, sinks: [collectingSink(records)] })
    logger.info('real', { msg: 'evil', level: 'error', ts: 0 })
    const record = records[0]
    expect(record?.msg).toBe('real')
    expect(record?.level).toBe('info')
    expect(record?.ts).toBe(123)
  })

  test('一个 sink 抛错，另一个 sink 仍收到记录', () => {
    const records: Array<Readonly<Record<string, unknown>>> = []
    const throwing: LogSink = {
      write() {
        throw new Error('sink boom')
      },
    }
    const logger = createLogger({ level: 'debug', sinks: [throwing, collectingSink(records)] })
    expect(() => {
      logger.info('kept')
    }).not.toThrow()
    expect(records.map((r) => r.msg)).toEqual(['kept'])
  })
})
