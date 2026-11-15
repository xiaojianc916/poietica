import { describe, expect, test } from 'bun:test'
import { pathKey } from '../path-key'
import { nameOfPath } from '../service'

describe('pathKey（07 页 §3G）', () => {
  test('解析成绝对路径、去尾分隔符、转小写；盘符根保留末尾分隔符', () => {
    expect(pathKey('C:\\Foo\\')).toBe(pathKey('c:\\foo'))
    expect(pathKey('C:\\Users\\A\\proj')).toBe('c:\\users\\a\\proj')
    expect(pathKey('C:\\')).toBe('c:\\')
    expect(pathKey('.')).toBe(pathKey(process.cwd()))
  })
})

describe('盘符根目录的名字（07 页 §3C 坑 5）', () => {
  test("'C:\\' 的名字是 'C:'（basename 是空串），普通目录取 basename", () => {
    expect(nameOfPath('C:\\')).toBe('C:')
    expect(nameOfPath('C:\\Users\\a\\proj')).toBe('proj')
  })
})
