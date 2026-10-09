import { describe, expect, test } from 'bun:test'
import { createOutputBatcher } from '../output-batcher'

describe('TM-3: output-batcher', () => {
  test('连续 100 次 push 在 8ms 后只送出一条，内容为拼接结果', async () => {
    const sent: string[] = []
    const batcher = createOutputBatcher((data) => {
      sent.push(data)
    }, 8)

    for (let i = 0; i < 100; i += 1) batcher.push(`line-${i}\n`)
    expect(sent.length).toBe(0)

    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(sent.length).toBe(1)
    expect(sent[0]?.split('\n').length).toBe(101)
    expect(sent[0]?.startsWith('line-0\n')).toBe(true)
    expect(sent[0]?.endsWith('line-99\n')).toBe(true)
    batcher.dispose()
  })

  test('drain 立刻送出缓冲（不等到期），退出前用它把最后几行排空', () => {
    const sent: string[] = []
    const batcher = createOutputBatcher((data) => {
      sent.push(data)
    })

    batcher.push('a')
    batcher.push('b')
    batcher.drain()
    expect(sent).toEqual(['ab'])
    batcher.dispose()
  })

  test('drain 之后再 push 会重新起一个窗口', () => {
    const sent: string[] = []
    const batcher = createOutputBatcher((data) => {
      sent.push(data)
    })

    batcher.push('a')
    batcher.drain()
    batcher.push('b')
    batcher.drain()
    expect(sent).toEqual(['a', 'b'])
    batcher.dispose()
  })

  test('dispose 丢掉未送出的内容', async () => {
    const sent: string[] = []
    const batcher = createOutputBatcher((data) => {
      sent.push(data)
    })

    batcher.push('a')
    batcher.dispose()
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(sent).toEqual([])
  })
})

describe('R-08-15: output-batcher 的 offset', () => {
  test('每段 flush 带自己的起点，起点是累计位置（含被丢弃的合批窗口）', async () => {
    const sent: Array<{ data: string; offset: number }> = []
    const batcher = createOutputBatcher((data, offset) => {
      sent.push({ data, offset })
    }, 8)

    batcher.push('abc')
    batcher.push('de')
    batcher.drain()
    batcher.push('f')
    batcher.push('g')
    batcher.drain()
    batcher.dispose()

    expect(sent).toEqual([
      { data: 'abcde', offset: 0 },
      { data: 'fg', offset: 5 },
    ])
  })

  test('起点不随定时器到期或 drain 重置', async () => {
    const sent: Array<{ data: string; offset: number }> = []
    const batcher = createOutputBatcher((data, offset) => {
      sent.push({ data, offset })
    }, 8)

    batcher.push('xxxx')
    await new Promise((resolve) => setTimeout(resolve, 30))
    batcher.push('yy')
    batcher.drain()
    batcher.dispose()

    expect(sent).toEqual([
      { data: 'xxxx', offset: 0 },
      { data: 'yy', offset: 4 },
    ])
  })
})
