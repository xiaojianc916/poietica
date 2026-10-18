import { describe, expect, test } from 'bun:test'
import { createTestLogger } from '@poietica/test-kit'
import { createCoreOutputSink } from '../core-output'

describe('Core 的意外输出 → Host 日志', () => {
  test('stderr 行原样记一条 warn（scope core-output），不当 JSON 解析、不另写 core.log', () => {
    const logger = createTestLogger()
    const sink = createCoreOutputSink(logger)
    sink.line('{"level":"info","msg":"looks like json"}')
    sink.line('   ')
    sink.stray('garbage on stdout')
    expect(logger.records.map((r) => [r.level, r.msg, r.data.scope])).toEqual([
      ['warn', 'core stderr', 'core-output'],
      ['warn', 'core stdout stray', 'core-output'],
    ])
    expect(logger.records[0]?.data.line).toBe('{"level":"info","msg":"looks like json"}')
  })

  test('超长输出截到 2000 字符', () => {
    const logger = createTestLogger()
    createCoreOutputSink(logger).line('x'.repeat(10_000))
    expect(String(logger.records[0]?.data.line).length).toBe(2_000)
  })
})
