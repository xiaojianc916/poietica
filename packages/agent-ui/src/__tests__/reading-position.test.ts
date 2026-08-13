import { describe, expect, it } from 'vitest'
import { type RowSpan, rowAtAnchor } from '../feed/reading-position'
import { turnIndexAtRow } from '../threads/ordered-lookup'

/*
 * 只有起点。行首尾相接,所以第二行的起点就是第一行的终点 —— 终点是推得出来的,
 * 不需要声明,也就不需要在这里维护第二份。
 *
 * 第 1 行故意做得比视口还高:那是带代码块的长回答,也是估高与真高落差最大的
 * 地方,越界判断必须在它内部任意位置都稳定。
 */
const SPANS: readonly RowSpan[] = [
  { index: 0, start: 0 },
  { index: 1, start: 80 },
  { index: 2, start: 1200 },
]

const TURNS = [{ rowIndex: 0 }, { rowIndex: 4 }, { rowIndex: 9 }, { rowIndex: 30 }]

describe('rowAtAnchor', () => {
  it('没有区间时说不知道,而不是谎称第 0 行', () => {
    expect(rowAtAnchor([], 500)).toBeNull()
  })

  it('锚点落在某一行内部时给出那一行', () => {
    expect(rowAtAnchor(SPANS, 40)).toBe(SPANS[0])
    expect(rowAtAnchor(SPANS, 600)).toBe(SPANS[1])
    expect(rowAtAnchor(SPANS, 1230)).toBe(SPANS[2])
  })

  it('边界归下一行:一行的起点属于它自己', () => {
    expect(rowAtAnchor(SPANS, 80)).toBe(SPANS[1])
    expect(rowAtAnchor(SPANS, 79)).toBe(SPANS[0])
    expect(rowAtAnchor(SPANS, 1200)).toBe(SPANS[2])
  })

  it('锚点在第一行之前时归第一行', () => {
    expect(rowAtAnchor(SPANS, -300)).toBe(SPANS[0])
  })

  it('锚点越过最后一行时归最后一行', () => {
    expect(rowAtAnchor(SPANS, 99999)).toBe(SPANS[2])
  })
})

describe('turnIndexAtRow', () => {
  it('没有轮次时归 0', () => {
    expect(turnIndexAtRow([], 12)).toBe(0)
  })

  it('取最后一个不晚于当前行的轮次', () => {
    expect(turnIndexAtRow(TURNS, 0)).toBe(0)
    expect(turnIndexAtRow(TURNS, 3)).toBe(0)
    expect(turnIndexAtRow(TURNS, 4)).toBe(1)
    expect(turnIndexAtRow(TURNS, 8)).toBe(1)
    expect(turnIndexAtRow(TURNS, 9)).toBe(2)
    expect(turnIndexAtRow(TURNS, 29)).toBe(2)
    expect(turnIndexAtRow(TURNS, 30)).toBe(3)
  })

  it('当前行越过最后一轮时停在最后一轮', () => {
    expect(turnIndexAtRow(TURNS, 9999)).toBe(3)
  })

  it('当前行在第一轮之前时停在第一轮', () => {
    expect(turnIndexAtRow(TURNS, -1)).toBe(0)
  })
})
