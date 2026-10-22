import { describe, expect, test } from 'bun:test'
import path from 'node:path'
import { isInside } from '../paths'

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

  /* 下面两条按本机分隔符拼路径：上面几条是 Windows 写法，只在 Windows 上成立。 */
  test('名字以两个点开头的子目录仍在里面（`..foo` 不是 `..`）', () => {
    const root = path.resolve('/workspace/repo')
    expect(isInside(root, path.join(root, '..foo'))).toBe(true)
    expect(isInside(root, path.join(root, '..foo', 'a.ts'))).toBe(true)
    expect(isInside(root, path.join(root, '...'))).toBe(true)
  })

  test('真正的上一级与兄弟目录仍为假', () => {
    const root = path.resolve('/workspace/repo')
    expect(isInside(root, path.join(root, '..'))).toBe(false)
    expect(isInside(root, path.join(root, '..', 'other'))).toBe(false)
    expect(isInside(root, `${root}-other`)).toBe(false)
  })
})
