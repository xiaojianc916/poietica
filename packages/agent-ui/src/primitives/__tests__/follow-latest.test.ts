import { describe, expect, it } from 'vitest'
import {
  distanceFromEnd,
  easeOut,
  type FollowState,
  nextFollow,
  staysWithLatest,
  travelStep,
} from '../follow-latest'

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

describe('easeOut', () => {
  it('starts at the origin and lands on the target', () => {
    expect(easeOut(0)).toBe(0)
    expect(easeOut(1)).toBe(1)
  })

  it('spends most of the distance early', () => {
    expect(easeOut(0.5)).toBe(0.875)
  })
})

describe('travelStep', () => {
  /* 目标每帧重算：行被测量、内容长高都只是挪终点,不该把这一段打断。 */
  it('reads the target out of the geometry it is given', () => {
    const halfway = travelStep(100, { clientHeight: 600, scrollHeight: 4000, scrollTop: 100 }, 0.5)

    expect(halfway).toBe(2987.5)
  })

  it('follows a target that moved while the travel was under way', () => {
    const grown = travelStep(100, { clientHeight: 600, scrollHeight: 5000, scrollTop: 100 }, 0.5)

    expect(grown).toBe(3862.5)
  })

  it('reports the travel done when the budget runs out', () => {
    expect(travelStep(100, { clientHeight: 600, scrollHeight: 4000, scrollTop: 900 }, 1)).toBe(null)
  })

  it('reports the travel done once the end sits behind the box', () => {
    const shrunk = { clientHeight: 600, scrollHeight: 900, scrollTop: 400 }

    expect(travelStep(100, shrunk, 0.5)).toBe(null)
  })

  /* 回归：位移途中任何一次向上写入都是一下可见的抽动。 */
  it('never steps back up the page', () => {
    const ahead = { clientHeight: 600, scrollHeight: 4000, scrollTop: 3000 }

    expect(travelStep(100, ahead, 0.1)).toBe(3000)
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

  it('keeps the travel while it is still under way', () => {
    expect(nextFollow(FAR, { ...AT_END, scrollTop: 200 }, TRAVELING, false)).toEqual(TRAVELING)
  })

  /* 回归：位移进了近末端那一带也不收状态,收过的那一版会在落底前被往上顶一下。 */
  it('does not take the wheel back inside the near-end band', () => {
    expect(nextFollow({ ...AT_END, scrollTop: 380 }, AT_END, TRAVELING, false)).toEqual(TRAVELING)
  })

  it('gives up the travel the moment someone scrolls up', () => {
    expect(nextFollow(AT_END, { ...AT_END, scrollTop: 300 }, TRAVELING, false)).toEqual(LET_GO)
  })
})
