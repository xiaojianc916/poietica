import { describe, expect, test } from 'bun:test'
import { deriveTitle, normalizeTitle, PENDING_TITLE } from '../title'

describe('CV-2 标题规则', () => {
  test('空白折叠、去首尾', () => {
    expect(deriveTitle('  修复\n登录  bug ')).toBe('修复 登录 bug')
  })

  test('空文本得到 pending 标题', () => {
    expect(deriveTitle('   \n  ')).toBe(PENDING_TITLE)
  })

  test('61 个汉字截断为 60 个加省略号', () => {
    const text = '字'.repeat(61)
    const title = deriveTitle(text)
    expect(Array.from(title).length).toBe(61)
    expect(title.endsWith('…')).toBe(true)
    expect(title.slice(0, -1)).toBe('字'.repeat(60))
  })

  test('恰好 60 个不截断', () => {
    const text = '字'.repeat(60)
    expect(deriveTitle(text)).toBe(text)
  })

  test('按 Unicode 字符而不是 UTF-16 码元截断（emoji 不被劈开）', () => {
    const text = '🙂'.repeat(61)
    const title = deriveTitle(text)
    expect(Array.from(title).length).toBe(61)
    expect(title).toBe(`${'🙂'.repeat(60)}…`)
  })

  test('rename 的规则：去首尾空白后截断到 120 个字符', () => {
    expect(normalizeTitle('  标题  ')).toBe('标题')
    expect(Array.from(normalizeTitle('x'.repeat(130))).length).toBe(120)
  })
})
