import { describe, expect, it } from 'bun:test'

import { readThoughtLine } from '../timeline/thought-line'

/*
 * 这一格印的是原文里的那一行，不是它的 markdown 语义。任何过滤都会让它在模型写围栏、
 * 写表格的整段时间里停在一句旧话上 —— 而屏幕上看不出漏了哪一句，只有这里看得出。
 */
describe('readThoughtLine', () => {
  it('印的是正在写的那一行', () => {
    expect(readThoughtLine('先看契约\n再看调用点', 'tail')).toBe('再看调用点')
    expect(readThoughtLine('先看契约\n再看调用点', 'head')).toBe('先看契约')
  })

  it('原文逐字，标记不去壳', () => {
    expect(readThoughtLine('## 结论\n| 列 | 值 |', 'tail')).toBe('| 列 | 值 |')
    expect(readThoughtLine('## 结论\n正文', 'head')).toBe('## 结论')
  })

  it('围栏里的那一行也要印', () => {
    expect(readThoughtLine('推导\n$$\na + b\n', 'tail')).toBe('a + b')
  })

  it('空行不算一行', () => {
    expect(readThoughtLine('落定。\n\n\n', 'tail')).toBe('落定。')
    expect(readThoughtLine('\n\n开头', 'head')).toBe('开头')
    expect(readThoughtLine('', 'tail')).toBe('')
  })
})
