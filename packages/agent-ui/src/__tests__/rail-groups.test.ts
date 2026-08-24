import { describe, expect, it } from 'bun:test'
import type { ConversationTurn } from '@poietica/agent'
import { groupTurns, RAIL_MAX_BARS, railCentre } from '../minimap/rail-groups'
import { turnIndexAtRow } from '../threads/ordered-lookup'

/*
 * 造轮次。断言只碰 groupTurns 会读的字段，所以这里只保证「够用」。行号刻意留出
 * 空隙：轮次之间还有别的行，rowIndex 不等于序号 —— 这与真实时间线一致。
 */
function turn(ordinal: number): ConversationTurn {
  return {
    id: `t${String(ordinal)}`,
    rowIndex: ordinal * 3,
    label: `第 ${String(ordinal)} 问`,
  } as ConversationTurn
}

function conversation(length: number): readonly ConversationTurn[] {
  return Array.from({ length }, (_unused, index) => turn(index + 1))
}

/** 一格覆盖的轮次闭区间，turn 与 cluster 统一成同一种形状。 */
function span(item: ReturnType<typeof groupTurns>[number]): readonly [number, number] {
  return item.kind === 'cluster' ? [item.from, item.to] : [item.ordinal, item.ordinal]
}

/*
 * 这里写死 12 和 6，不 import RAIL_PITCH_PX：中线算术是与样式表 --cp-rail-hit 的
 * 契约，import 会让「只改了一边」的提交照样变绿，而那正是要拦的事故。
 */
describe('railCentre', () => {
  it('第一格的中线是半格', () => {
    expect(railCentre(0)).toBe(6)
  })

  it('逐格前进一个步距', () => {
    for (let index = 1; index < 10; index += 1) {
      expect(railCentre(index) - railCentre(index - 1)).toBe(12)
    }
  })
})

describe('groupTurns', () => {
  it('空会话没有格子', () => {
    expect(groupTurns([], RAIL_MAX_BARS)).toEqual([])
  })

  it('装得下就一轮一格，身份就是轮次的 id', () => {
    const turns = conversation(RAIL_MAX_BARS)
    const items = groupTurns(turns, RAIL_MAX_BARS)

    expect(items.map((item) => item.id)).toEqual(turns.map((each) => each.id))
    expect(items.every((item) => item.kind === 'turn')).toBe(true)
  })

  /*
   * 这次改动要钉住的性质：分格是轮次的纯函数。签名里没有滚动位置，同一份轮次
   * 算多少遍都是同一批格子 —— 上一版把 activeRow 喂进分格，人一滚，横条就增减。
   */
  it.each([1, 8, 31, 32, 33, 64, 200, 1000])('N=%i：格子只由轮次决定', (length) => {
    const turns = conversation(length)
    const first = groupTurns(turns, RAIL_MAX_BARS)
    const again = groupTurns(turns, RAIL_MAX_BARS)

    expect(again).toEqual(first)
  })

  it.each([1, 8, 31, 32, 33, 64, 200, 1000])('N=%i：格数不超封顶也不超轮数', (length) => {
    const items = groupTurns(conversation(length), RAIL_MAX_BARS)

    expect(items.length).toBeGreaterThan(0)
    expect(items.length).toBeLessThanOrEqual(RAIL_MAX_BARS)
    expect(items.length).toBeLessThanOrEqual(length)
  })

  it.each([33, 64, 200, 1000])('N=%i：区间无缝、完整、段首代表段', (length) => {
    const turns = conversation(length)
    const items = groupTurns(turns, RAIL_MAX_BARS)
    const spans = items.map(span)

    expect(spans.at(0)?.[0]).toBe(1)
    expect(spans.at(-1)?.[1]).toBe(length)

    for (let index = 1; index < spans.length; index += 1) {
      expect(spans[index]?.[0]).toBe((spans[index - 1]?.[1] ?? Number.NaN) + 1)
    }

    const heads = spans.map(([from]) => turn(from))

    expect(items.map((item) => item.id)).toEqual(heads.map((head) => head.id))
    expect(items.map((item) => item.rowIndex)).toEqual(heads.map((head) => head.rowIndex))
  })

  it('rowIndex 严格递增，二分的前提成立', () => {
    const items = groupTurns(conversation(1000), RAIL_MAX_BARS)
    const rows = items.map((item) => item.rowIndex)
    const sorted = [...rows].sort((a, b) => a - b)

    expect(rows).toEqual(sorted)
    expect(new Set(rows).size).toBe(rows.length)
  })

  it('并格之后二分照旧指对格', () => {
    const items = groupTurns(conversation(200), RAIL_MAX_BARS)

    for (const [index, item] of items.entries()) {
      expect(turnIndexAtRow(items, item.rowIndex)).toBe(index)
      expect(turnIndexAtRow(items, item.rowIndex + 1)).toBe(index)
    }
  })

  it('单轮的段不套 cluster 的壳', () => {
    /* 33 轮 32 格装不下，段长 2：最后一段只剩 1 轮，必须退化成 turn。 */
    const items = groupTurns(conversation(33), RAIL_MAX_BARS)

    expect(items.at(-1)?.kind).toBe('turn')
  })

  it('预算只剩一格时全并成一格', () => {
    const items = groupTurns(conversation(200), 1)

    expect(items.map(span)).toEqual([[1, 200]])
  })
})
