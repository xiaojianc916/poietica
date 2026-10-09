import { describe, expect, test } from 'bun:test'
import { isInside, samePath } from '../paths'

describe('isInside', () => {
  test('子目录为真', () => {
    expect(isInside('C:\\a', 'C:\\a\\b')).toBe(true)
  })

  test('大小写不敏感', () => {
    expect(isInside('C:\\a', 'C:\\A\\B')).toBe(true)
  })

  test('同前缀但不同目录为假', () => {
    expect(isInside('C:\\a', 'C:\\ab')).toBe(false)
  })

  test('相等时默认假，orEqual 为真', () => {
    expect(isInside('C:\\a', 'C:\\a')).toBe(false)
    expect(isInside('C:\\a', 'C:\\a', { orEqual: true })).toBe(true)
  })

  test('经 .. 逃出为假', () => {
    expect(isInside('C:\\a', 'C:\\a\\..\\b')).toBe(false)
  })

  test('不同盘符为假', () => {
    expect(isInside('C:\\a', 'D:\\a\\b')).toBe(false)
  })
})

describe('samePath', () => {
  test('解析为绝对路径后不区分大小写', () => {
    expect(samePath('C:\\a\\b', 'c:/A/B')).toBe(true)
    expect(samePath('C:\\a\\b', 'C:\\a\\c')).toBe(false)
  })
})
