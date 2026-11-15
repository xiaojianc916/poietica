import { describe, expect, test } from 'bun:test'
import { deriveTitle, forkTitleOf, normalizeTitle, PENDING_TITLE } from '../title'

describe('CV-2 标题规则', () => {
  test('空白折叠、去首尾；空文本得到 pending 标题', () => {
    expect(deriveTitle('  修复\n登录  bug ')).toBe('修复 登录 bug')
    expect(deriveTitle('   \n  ')).toBe(PENDING_TITLE)
  })

  test('第 61 个字起截断并加省略号，恰好 60 个不动；按 Unicode 字符截而不是 UTF-16 码元', () => {
    const sixty = '字'.repeat(60)
    expect(deriveTitle(sixty)).toBe(sixty)
    expect(deriveTitle(`${sixty}字`)).toBe(`${sixty}…`)
    expect(deriveTitle('🙂'.repeat(61))).toBe(`${'🙂'.repeat(60)}…`)
  })

  test('rename 的规则：去首尾空白后截断到 120 个字符', () => {
    expect(normalizeTitle('  标题  ')).toBe('标题')
    expect(Array.from(normalizeTitle('x'.repeat(130))).length).toBe(120)
  })
})

describe('CV-3 分叉标题', () => {
  test('第一次分叉是（分支），再分叉按序号进档', () => {
    const first = forkTitleOf('修登录页')
    const second = forkTitleOf(first)
    expect(first).toBe('修登录页（分支）')
    expect(second).toBe('修登录页（分支2）')
    expect(forkTitleOf(second)).toBe('修登录页（分支3）')
  })

  test('旧数据里叠出来的（分支）（分支）收拢成（分支2）', () => {
    expect(forkTitleOf('修登录页（分支）（分支）')).toBe('修登录页（分支2）')
    expect(forkTitleOf('修登录页（分支2）（分支）')).toBe('修登录页（分支3）')
  })

  test('「（分支）」只有落在末尾才算后缀：中间的原样留在正文里', () => {
    expect(forkTitleOf('（分支）这件事怎么办')).toBe('（分支）这件事怎么办（分支）')
    expect(forkTitleOf('（分支）')).toBe('（分支2）')
  })

  test('留给正文 116 个字符：长名字先截正文，序号留在末尾', () => {
    const title = forkTitleOf('字'.repeat(130))
    expect(Array.from(title)).toHaveLength(120)
    expect(title.endsWith('（分支）')).toBe(true)
    expect(Array.from(title).slice(0, -4).join('')).toBe('字'.repeat(116))
  })
})
