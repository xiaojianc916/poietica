import { expect, test } from 'bun:test'
import { formatBytes } from '../format-bytes'

/* 断言按它的实际行为写：Intl 一位小数（所以 1 KB 不是 1.0 KB），且只到 MB 一档。 */
test('formatBytes：逐档进位、一位小数、只到 MB', () => {
  expect(formatBytes(0)).toBe('0 B')
  expect(formatBytes(1023)).toBe('1,023 B')
  expect(formatBytes(1024)).toBe('1 KB')
  expect(formatBytes(1536)).toBe('1.5 KB')
  expect(formatBytes(1024 * 1024)).toBe('1 MB')
  expect(formatBytes(1024 * 1024 * 1024)).toBe('1,024 MB')
})
