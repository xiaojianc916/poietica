import { describe, expect, test } from 'bun:test'
import { pathKey } from '../path-key'
import { nameOfPath } from '../service'

describe('pathKey（07 页 §3G）', () => {
  test("pathKey('C:\\Foo\\') 与 pathKey('c:\\foo') 相等", () => {
    expect(pathKey('C:\\Foo\\')).toBe(pathKey('c:\\foo'))
  })

  test("pathKey('C:\\') === 'c:\\'（根目录保留末尾分隔符）", () => {
    expect(pathKey('C:\\')).toBe('c:\\')
  })

  test('普通路径去掉末尾分隔符并转小写', () => {
    expect(pathKey('C:\\Users\\A\\proj')).toBe('c:\\users\\a\\proj')
  })

  test('相对路径先解析为绝对路径', () => {
    expect(pathKey('.')).toBe(pathKey(process.cwd()))
  })
})

describe('盘符根目录的名字（07 页 §3C 坑 5）', () => {
  test("'C:\\' 的名字是 'C:'（basename 是空串）", () => {
    expect(nameOfPath('C:\\')).toBe('C:')
  })

  test('普通目录取 basename', () => {
    expect(nameOfPath('C:\\Users\\a\\proj')).toBe('proj')
  })
})
