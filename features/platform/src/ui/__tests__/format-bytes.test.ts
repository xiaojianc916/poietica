import { describe, expect, test } from 'bun:test'
import { formatBytes } from '@poietica/design-system'

/*
 * formatBytes 是 design-system 的导出（迁移自 legacy 的同名工具，逐字未改）。
 * 断言按它的实际行为写：Intl 一位小数（所以 1 KB 不是 1.0 KB），且只到 MB 一档。
 */
describe('formatBytes', () => {
  test('小于 1KB 用 B', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(1023)).toBe('1,023 B')
  })
  test('逐档进位', () => {
    expect(formatBytes(1024)).toBe('1 KB')
    expect(formatBytes(1024 * 1024)).toBe('1 MB')
  })
  test('保留一位小数', () => {
    expect(formatBytes(1536)).toBe('1.5 KB')
  })
  test('到 MB 封顶，更大的数按 MB 计', () => {
    // Intl 千分位：1024 MB 会写成 1,024
    expect(formatBytes(1024 * 1024 * 1024)).toBe('1,024 MB')
  })
})
