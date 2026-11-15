import { describe, expect, test } from 'bun:test'
import path from 'node:path'
import { isInside } from '../paths'

/* 上面几条是 Windows 写法；下面两条按本机分隔符拼路径。 */
describe('isInside', () => {
  test('子目录（大小写不敏感）为真；同前缀、不同盘符、经 .. 逃出都为假', () => {
    expect(isInside('C:\\a', 'C:\\a\\b')).toBe(true)
    expect(isInside('C:\\a', 'C:\\A\\B')).toBe(true)
    expect(isInside('C:\\a', 'C:\\ab')).toBe(false)
    expect(isInside('C:\\a', 'C:\\a\\..\\b')).toBe(false)
    expect(isInside('C:\\a', 'D:\\a\\b')).toBe(false)
  })

  test('相等时默认假，orEqual 为真', () => {
    expect(isInside('C:\\a', 'C:\\a')).toBe(false)
    expect(isInside('C:\\a', 'C:\\a', { orEqual: true })).toBe(true)
  })

  test('名字以两个点开头（`..foo`、`...`）仍在里面；真正的上一级与兄弟目录在外面', () => {
    const root = path.resolve('/workspace/repo')
    expect(isInside(root, path.join(root, '..foo'))).toBe(true)
    expect(isInside(root, path.join(root, '..foo', 'a.ts'))).toBe(true)
    expect(isInside(root, path.join(root, '...'))).toBe(true)

    expect(isInside(root, path.join(root, '..'))).toBe(false)
    expect(isInside(root, path.join(root, '..', 'other'))).toBe(false)
    expect(isInside(root, `${root}-other`)).toBe(false)
  })
})
