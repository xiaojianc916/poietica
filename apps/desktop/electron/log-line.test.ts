import { describe, expect, test } from 'bun:test'

import { jsonLine, render } from './log-line'

const DATE = new Date('2026-10-04T04:00:00.000Z')

function parse(line: string): Record<string, unknown> {
  return JSON.parse(line) as Record<string, unknown>
}

describe('主进程日志的一行', () => {
  test('是一条 JSON，字段与原生侧对齐', () => {
    const line = jsonLine({ data: ['something failed'], level: 'warn', date: DATE })

    expect(parse(line)).toEqual({
      timestamp: '2026-10-04T04:00:00.000Z',
      level: 'WARN',
      target: 'main',
      message: 'something failed',
    })
  })

  test('含引号与换行的正文仍是一条 JSON，不是两行', () => {
    const line = jsonLine({ data: ['a "quoted" \n line'], level: 'error', date: DATE })

    expect(line).not.toContain('\n')
    expect(parse(line)['message']).toBe('a "quoted" \n line')
  })

  test('凭据落盘之前就被换掉', () => {
    const line = jsonLine({
      data: ['Authorization: Bearer abc.def https://user:pass@example.com/x'],
      level: 'error',
      date: DATE,
    })

    expect(line).not.toContain('abc.def')
    expect(line).not.toContain('pass')
  })

  test('Error 取栈，不是一个空对象', () => {
    const line = jsonLine({ data: [new Error('boom')], level: 'error', date: DATE })

    expect(String(parse(line)['message'])).toContain('boom')
  })

  test('对象与不可序列化的值都有正文，不会写成 undefined', () => {
    expect(render({ a: 1 })).toBe('{"a":1}')

    const circular: Record<string, unknown> = {}

    circular['self'] = circular

    expect(render(circular)).toBe('[object Object]')
    expect(parse(jsonLine({ data: [undefined], level: 'warn', date: DATE }))['message']).toBe(
      'undefined',
    )
  })
})
