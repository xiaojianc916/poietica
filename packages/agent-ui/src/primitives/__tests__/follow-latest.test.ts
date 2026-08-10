import { describe, expect, it } from 'vitest'
import { distanceFromEnd, type FollowState, nextFollow, staysWithLatest } from '../follow-latest'

/*
 * 判据是纯的，所以它能脱离 DOM 钉住 —— 这也是把它从 hook 里分出来的理由：jsdom 的
 * scrollHeight 与 clientHeight 恒为 0，留在组件里就永远测不到这几种几何。
 */
const AT_END = { clientHeight: 600, scrollHeight: 1000, scrollTop: 400 }
const FAR = { ...AT_END, scrollTop: 100 }

const FOLLOWING: FollowState = { follows: true, traveling: false }
const LET_GO: FollowState = { follows: false, traveling: false }
const TRAVELING: FollowState = { follows: true, traveling: true }

describe('staysWithLatest', () => {
  it('reads the distance straight off one box', () => {
    expect(distanceFromEnd(AT_END)).toBe(0)
  })

  it('holds when the box sits at the end', () => {
    expect(staysWithLatest(AT_END)).toBe(true)
  })

  it('still holds one wheel notch away', () => {
    expect(staysWithLatest({ ...AT_END, scrollTop: 352 })).toBe(true)
  })

  it('lets go one pixel past that notch', () => {
    expect(staysWithLatest({ ...AT_END, scrollTop: 351 })).toBe(false)
  })

  it('holds when the content does not overflow', () => {
    expect(staysWithLatest({ clientHeight: 600, scrollHeight: 600, scrollTop: 0 })).toBe(true)
  })

  it('holds while the box rubber-bands past the end', () => {
    expect(staysWithLatest({ ...AT_END, scrollTop: 500 })).toBe(true)
  })
})

describe('nextFollow', () => {
  /* 回归：带动画的滚轮一格只走几个像素，而它必须已经算作「人走开了」。 */
  it('lets go on the first few pixels of a wheel notch', () => {
    expect(nextFollow(AT_END, { ...AT_END, scrollTop: 396 }, FOLLOWING, false)).toEqual(LET_GO)
  })

  it('keeps following the scroll we wrote ourselves', () => {
    expect(nextFollow(AT_END, { ...AT_END, scrollTop: 396 }, FOLLOWING, true)).toEqual(FOLLOWING)
  })

  it('does not mistake a clamp after the content shrank for a gesture', () => {
    const shorter = { clientHeight: 600, scrollHeight: 900, scrollTop: 300 }

    expect(nextFollow(AT_END, shorter, FOLLOWING, false)).toEqual(FOLLOWING)
  })

  it('takes the reader back once they scroll near the end again', () => {
    expect(nextFollow(FAR, AT_END, LET_GO, false)).toEqual(FOLLOWING)
  })

  it('stays let go while the reader is still far from the end', () => {
    expect(nextFollow(FAR, { ...AT_END, scrollTop: 200 }, LET_GO, false)).toEqual(LET_GO)
  })

  it('does not follow content that grows under a reader who left', () => {
    const grown = { clientHeight: 600, scrollHeight: 1400, scrollTop: 100 }

    expect(nextFollow(FAR, grown, LET_GO, false)).toEqual(LET_GO)
  })

  /* 位移途中距离还很远，但那是我们在把人送回去，不是人在离开。 */
  it('keeps the latch armed while a travel is still under way', () => {
    expect(nextFollow(FAR, { ...AT_END, scrollTop: 200 }, TRAVELING, false)).toEqual(TRAVELING)
  })

  it('hands the last stretch back to the instant pin', () => {
    expect(nextFollow({ ...AT_END, scrollTop: 200 }, AT_END, TRAVELING, false)).toEqual(FOLLOWING)
  })

  /* 位移途中有人拨了滚轮：浏览器会中止动画，这里必须当场让开，否则落定后又把人拽回去。 */
  it('gives up the travel the moment someone scrolls up', () => {
    expect(nextFollow(AT_END, { ...AT_END, scrollTop: 300 }, TRAVELING, false)).toEqual(LET_GO)
  })
})
