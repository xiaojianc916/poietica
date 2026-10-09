import { describe, expect, test } from 'bun:test'
import { redactSecrets } from '../redact'

describe('redactSecrets', () => {
  test('凭据键的字符串值全部变为 [redacted]', () => {
    expect(redactSecrets({ apiKey: 'sk-1', api_key: 'x', authorization: 'Bearer y', key: 'z' })).toEqual({
      apiKey: '[redacted]',
      api_key: '[redacted]',
      authorization: '[redacted]',
      key: '[redacted]',
    })
  })

  test('非凭据键与数值字段原样保留', () => {
    expect(redactSecrets({ keys: ['A', 'B'], inputTokens: 12, tokens: 3 })).toEqual({
      keys: ['A', 'B'],
      inputTokens: 12,
      tokens: 3,
    })
  })

  test('嵌套对象与数组中的 password 被脱敏', () => {
    expect(redactSecrets({ nested: { password: 'p' }, list: [{ password: 'q' }] })).toEqual({
      nested: { password: '[redacted]' },
      list: [{ password: '[redacted]' }],
    })
  })

  test('循环引用替换为 [circular]', () => {
    const input: Record<string, unknown> = { name: 'n' }
    input.self = input
    const out = redactSecrets(input) as Record<string, unknown>
    expect(out.name).toBe('n')
    expect(out.self).toBe('[circular]')
  })

  test('Error 转成 {name, message, stack}', () => {
    const out = redactSecrets(new Error('m')) as Record<string, unknown>
    expect(out.name).toBe('Error')
    expect(out.message).toBe('m')
    expect(typeof out.stack).toBe('string')
  })

  test('9000 字符的字符串被截断并带 [truncated 808]', () => {
    const out = redactSecrets('x'.repeat(9000)) as string
    expect(out.length).toBeLessThan(9000)
    expect(out.endsWith('[truncated 808]')).toBe(true)
  })

  test('输入对象未被修改', () => {
    const input = { apiKey: 'sk-1', nested: { password: 'p', list: ['a'] } }
    const snapshot = structuredClone(input)
    redactSecrets(input)
    expect(input).toEqual(snapshot)
  })
})
