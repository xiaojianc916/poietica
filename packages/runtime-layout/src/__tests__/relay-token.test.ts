import { describe, expect, test } from 'bun:test'
import { parseRelayToken } from '../relay-token'

const TOKEN = 'ab'.repeat(32)

describe('parseRelayToken', () => {
  test('RT-1 64 位小写十六进制原样返回，首尾空白（编辑器补的换行）去掉', () => {
    expect(parseRelayToken(TOKEN)).toBe(TOKEN)
    expect(parseRelayToken(`${TOKEN}\n`)).toBe(TOKEN)
  })

  test('RT-2 长度不对、大写、非十六进制、空文件一律 null', () => {
    expect(parseRelayToken(TOKEN.slice(1))).toBeNull()
    expect(parseRelayToken(`${TOKEN}0`)).toBeNull()
    expect(parseRelayToken(TOKEN.toUpperCase())).toBeNull()
    expect(parseRelayToken('z'.repeat(64))).toBeNull()
    expect(parseRelayToken('')).toBeNull()
  })
})
