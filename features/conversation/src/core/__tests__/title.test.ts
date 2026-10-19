import { describe, expect, test } from 'bun:test'
import { deriveTitle, forkTitleOf, normalizeTitle, PENDING_TITLE } from '../title'

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

describe('CV-3 分叉标题', () => {
  test('第一次分叉是（分支）', () => {
    expect(forkTitleOf('修登录页')).toBe('修登录页（分支）')
  })

  test('再分叉是（分支2），不是再叠一段（分支）', () => {
    const first = forkTitleOf('修登录页')
    const second = forkTitleOf(first)
    const third = forkTitleOf(second)
    expect(second).toBe('修登录页（分支2）')
    expect(third).toBe('修登录页（分支3）')
  })

  test('旧数据里已经叠出来的（分支）（分支）收拢成（分支2）', () => {
    expect(forkTitleOf('修登录页（分支）（分支）')).toBe('修登录页（分支2）')
    expect(forkTitleOf('修登录页（分支）（分支）（分支）')).toBe('修登录页（分支2）')
    expect(forkTitleOf('修登录页（分支2）（分支）')).toBe('修登录页（分支3）')
  })

  test('名字中间带（分支）不算后缀，原样留在正文里', () => {
    expect(forkTitleOf('（分支）这件事怎么办')).toBe('（分支）这件事怎么办（分支）')
  })

  test('用户手动起的同名不叠加：带序号的照序号进一档', () => {
    expect(forkTitleOf('（分支）')).toBe('（分支2）')
  })

  test('留给正文 116 个字符：长名字先截正文，序号留在末尾', () => {
    const title = forkTitleOf('字'.repeat(130))
    expect(Array.from(title)).toHaveLength(120)
    expect(title.endsWith('（分支）')).toBe(true)
    expect(Array.from(title).slice(0, -4).join('')).toBe('字'.repeat(116))
  })
})
