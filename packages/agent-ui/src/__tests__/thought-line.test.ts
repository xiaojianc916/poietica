import { describe, expect, it } from 'bun:test'

import { readThoughtLine } from '../timeline/thought-line'

describe('readThoughtLine', () => {
  it('印的是正在写的那一行', () => {
    expect(readThoughtLine('先看契约\n再看调用点', 'tail')).toBe('再看调用点')
    expect(readThoughtLine('先看契约\n再看调用点', 'head')).toBe('先看契约')
  })

  it('围栏里的代码不上这一行', () => {
    expect(readThoughtLine('要改这里\n```ts\nconst a = 1\n', 'tail')).toBe('要改这里')
    expect(readThoughtLine('```ts\n', 'tail')).toBe('')
  })

  it('表格与标题只留字', () => {
    expect(readThoughtLine('## 结论\n| 列 | 值 |\n| --- | --- |\n| a | 1 |', 'tail')).toBe('a 1')
    expect(readThoughtLine('## 结论\n正文', 'head')).toBe('结论')
  })

  it('行内标记去壳，链接留字', () => {
    expect(readThoughtLine('- 看 **这个** `foo_bar` 与 [文档](https://x)', 'tail')).toBe(
      '看 这个 foo_bar 与 文档',
    )
  })
})
