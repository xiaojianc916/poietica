import { describe, expect, test } from 'bun:test'
import { LineSplitter } from '../line-splitter'

function collect(): { lines: string[]; splitter: LineSplitter } {
  const lines: string[] = []
  return { lines, splitter: new LineSplitter((line) => lines.push(line)) }
}

describe('LineSplitter', () => {
  test('按 \\n 与 \\r\\n 切行，flush 输出不以换行结尾的残留', () => {
    const { lines, splitter } = collect()
    splitter.push('a\nb\r\nc')
    expect(lines).toEqual(['a', 'b'])
    splitter.flush()
    expect(lines).toEqual(['a', 'b', 'c'])
  })

  test('跨 chunk 的行', () => {
    const { lines, splitter } = collect()
    splitter.push('he')
    splitter.push('llo\nwo')
    splitter.push('rld\n')
    expect(lines).toEqual(['hello', 'world'])
    splitter.flush()
    expect(lines).toEqual(['hello', 'world'])
  })

  test('空行保留为 空字符串', () => {
    const { lines, splitter } = collect()
    splitter.push('a\n\nb\n')
    expect(lines).toEqual(['a', '', 'b'])
  })
})
