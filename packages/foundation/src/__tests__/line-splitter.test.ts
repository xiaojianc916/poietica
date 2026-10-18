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

describe('LineSplitter：大行与上限', () => {
  test('一行被切成很多片：只在换行处 join 一次，内容逐字节还原（含 U+2028 与跨片的 \\r\\n）', () => {
    const { lines, splitter } = collect()
    const body = `${'x'.repeat(10_000)}\u2028${'y'.repeat(10_000)}`
    const stream = `${body}\r\nnext\n`
    for (let i = 0; i < stream.length; i += 7) splitter.push(stream.slice(i, i + 7))
    expect(lines).toEqual([body, 'next'])
  })

  test('超长行：只报一次 overflow，并丢弃到下一个换行；后面的行照常交付', () => {
    const lines: string[] = []
    const overflows: string[] = []
    const splitter = new LineSplitter((line) => lines.push(line), {
      maxLineLength: 10,
      onOverflow: (head) => overflows.push(head),
    })
    splitter.push('ok\n0123456')
    splitter.push('789abcdef')
    splitter.push('ghij-tail\nafter\n')
    expect(overflows).toEqual(['0123456'])
    expect(lines).toEqual(['ok', 'after'])
  })

  test('一个 chunk 里就完整的超长行同样被拒（与切片方式无关）', () => {
    const lines: string[] = []
    const overflows: string[] = []
    const splitter = new LineSplitter((line) => lines.push(line), {
      maxLineLength: 4,
      onOverflow: (head) => overflows.push(head),
    })
    splitter.push('abcdefgh\nabcd\n')
    expect(overflows).toEqual(['abcdefgh'])
    expect(lines).toEqual(['abcd'])
  })

  test('丢弃态下 flush 不交出半截超长行', () => {
    const lines: string[] = []
    const splitter = new LineSplitter((line) => lines.push(line), { maxLineLength: 3, onOverflow: () => undefined })
    splitter.push('abcdef')
    splitter.flush()
    splitter.push('ok\n')
    expect(lines).toEqual(['ok'])
  })
})
