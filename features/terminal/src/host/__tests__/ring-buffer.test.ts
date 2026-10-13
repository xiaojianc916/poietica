import { describe, expect, test } from 'bun:test'
import { RingBuffer } from '../ring-buffer'

describe('TM-7: RingBuffer', () => {
  test("RingBuffer(10) 依次 push 'abcdef'、'ghijkl' → 'cdefghijkl'", () => {
    const ring = new RingBuffer(10)
    ring.push('abcdef')
    ring.push('ghijkl')
    expect(ring.read()).toBe('cdefghijkl')
  })

  test('单块超过上限：只留尾部', () => {
    const ring = new RingBuffer(4)
    ring.push('abcdefghij')
    expect(ring.read()).toBe('ghij')
  })

  test('content 长度恰好等于上限时不裁', () => {
    const ring = new RingBuffer(6)
    ring.push('abc')
    ring.push('def')
    expect(ring.read()).toBe('abcdef')
  })

  test('空内容读出空串', () => {
    expect(new RingBuffer(10).read()).toBe('')
  })

  /* 裁点回退到行首 —— 半截行（ANSI 转义序列被切一半）比丢一行更糟。 */
  test('裁点向后找到第一个换行：整块丢不掉时连半截行一起丢', () => {
    const ring = new RingBuffer(10)
    ring.push('aaa\n')
    ring.push('bbb\n')
    ring.push('cccc')
    expect(ring.read()).toBe('bbb\ncccc')
  })

  test('单块超过上限时同样从行首切', () => {
    const ring = new RingBuffer(10)
    ring.push('line-one\nline-two')
    expect(ring.read()).toBe('line-two')
  })
})
