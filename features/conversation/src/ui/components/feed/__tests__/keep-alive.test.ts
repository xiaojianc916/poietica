import { describe, expect, test } from 'bun:test'
import { KeepAlive, mergeRange } from '../keep-alive'

/* 常驻集合的纯逻辑：按 key 记、按最近使用淘汰、有上限。滚动区怎么接进渲染窗口（虚拟器下标、rowAtAnchor 的二分）需要真实几何，happy-dom 给不了，不在这里测。 */

describe('KeepAlive', () => {
  test('超出容量时从最旧的一端淘汰', () => {
    const kept = new KeepAlive(3)

    kept.touch(['a', 'b', 'c', 'd'])

    expect([...kept.keys()]).toEqual(['b', 'c', 'd'])
    expect(kept.size).toBe(3)
  })

  test('重复 touch 把 key 挪到最近端，淘汰顺序随之变化', () => {
    const kept = new KeepAlive(3)

    kept.touch(['a', 'b', 'c'])
    kept.touch(['a'])
    kept.touch(['d'])

    /* 没有第二次 touch(['a']) 的话，被淘汰的是 c。 */
    expect([...kept.keys()]).toEqual(['c', 'a', 'd'])
  })

  test('反复 touch 也不会超出上限', () => {
    const kept = new KeepAlive(8)

    for (let round = 0; round < 50; round += 1) {
      kept.touch([`row-${String(round)}`, `row-${String(round * 2)}`])
      expect(kept.size).toBeLessThanOrEqual(8)
    }
  })
})

describe('mergeRange', () => {
  const rowOf = (id: string): number | undefined => {
    const at = Number.parseInt(id.slice(1), 10)

    return Number.isNaN(at) ? undefined : at
  }

  test('默认区间与常驻行取并集，按升序交回', () => {
    expect(mergeRange([5, 6, 7], ['r2', 'r9'], rowOf, 20)).toEqual([2, 5, 6, 7, 9])
  })

  test('同一行被两边点到只出现一次', () => {
    expect(mergeRange([5, 6], ['r6'], rowOf, 20)).toEqual([5, 6])
  })

  test('越界与已不存在的行丢掉：向上续读会插行，保存的行号会位移', () => {
    expect(mergeRange([1], ['r0', 'r9', 'r7'], rowOf, 8)).toEqual([0, 1, 7])
    expect(mergeRange([1], ['gone'], rowOf, 8)).toEqual([1])
  })

  test('非字符串 key（当时那一行还没有 id）不常驻', () => {
    expect(mergeRange([4], [2, 'r3'], rowOf, 20)).toEqual([3, 4])
  })
})
