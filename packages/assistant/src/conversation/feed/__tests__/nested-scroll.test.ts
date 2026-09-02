import { describe, expect, it } from 'bun:test'
import { scrolledToEdge } from '../nested-scroll'

/* 行内自己滚的盒子什么时候把这一笔交给视口 —— 判据是纯的，不需要 DOM。 */
const BOX = { clientHeight: 200, scrollHeight: 600, scrollTop: 120 }

describe('scrolledToEdge', () => {
  it('keeps an upward notch while the box can still scroll up', () => {
    expect(scrolledToEdge(BOX, -1)).toBe(false)
  })

  it('hands an upward notch over at the top', () => {
    expect(scrolledToEdge({ ...BOX, scrollTop: 0 }, -1)).toBe(true)
  })

  it('hands a downward notch over at the bottom', () => {
    expect(scrolledToEdge({ ...BOX, scrollTop: 400 }, 1)).toBe(true)
  })

  it('ignores a purely horizontal gesture', () => {
    expect(scrolledToEdge({ ...BOX, scrollTop: 0 }, 0)).toBe(false)
  })
})
