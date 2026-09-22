import { describe, expect, test } from 'bun:test'
import { fileExtensionLabel, fileMetaLabel, formatByteSize } from './timeline-contract'

/*
 * 文件卡片那一行「类型 大小」的两个零件。边界是判据本身：
 * 四舍五入能跨过单位线，跨过去就得换一个单位 —— 写出「1024KB」是错的。
 */
describe('formatByteSize', () => {
  test('bytes below a kilobyte are shown as bytes', () => {
    expect(formatByteSize(0)).toBe('0B')
    expect(formatByteSize(1)).toBe('1B')
    expect(formatByteSize(1023)).toBe('1023B')
  })

  test('each unit boundary promotes', () => {
    expect(formatByteSize(1024)).toBe('1KB')
    expect(formatByteSize(1024 * 1024)).toBe('1MB')
    expect(formatByteSize(1024 * 1024 * 1024)).toBe('1GB')
  })

  test('rounding never prints a value of 1024 or more', () => {
    expect(formatByteSize(1048575)).toBe('1MB')
    expect(formatByteSize(1023.9 * 1024)).toBe('1MB')
    expect(formatByteSize(1024 * 1024 - 1)).toBe('1MB')
  })

  test('a fraction keeps two decimals and drops trailing zeros', () => {
    expect(formatByteSize(23440)).toBe('22.89KB')
    expect(formatByteSize(1536)).toBe('1.5KB')
    expect(formatByteSize(2048)).toBe('2KB')
  })

  test('an absent or impossible size has no label', () => {
    expect(formatByteSize(undefined)).toBeUndefined()
    expect(formatByteSize(Number.NaN)).toBeUndefined()
    expect(formatByteSize(-1)).toBeUndefined()
  })
})

describe('fileExtensionLabel', () => {
  test('a known extension is upper-cased', () => {
    expect(fileExtensionLabel('notes.txt')).toBe('TXT')
    expect(fileExtensionLabel('archive.tar.gz')).toBe('GZ')
  })

  test('a name without an extension says so', () => {
    expect(fileExtensionLabel('README')).toBe('文件')
    // 开头的点不是扩展名：.gitignore 没有后缀。
    expect(fileExtensionLabel('.gitignore')).toBe('文件')
  })

  test('a long extension is truncated', () => {
    expect(fileExtensionLabel('x.verylongext')).toBe('VERYL')
  })
})

describe('fileMetaLabel', () => {
  test('type and size are joined', () => {
    expect(fileMetaLabel('notes.txt', 23440)).toBe('TXT 22.89KB')
  })

  test('a missing size leaves only the type', () => {
    expect(fileMetaLabel('notes.txt', undefined)).toBe('TXT')
  })
})
