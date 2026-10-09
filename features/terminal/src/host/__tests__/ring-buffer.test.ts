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
})
