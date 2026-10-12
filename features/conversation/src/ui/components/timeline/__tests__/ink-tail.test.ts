import { describe, expect, it } from 'bun:test'
import { INK_MS, nextInk } from '../ink-tail'

/*
 * 墨迹尾巴的账：哪几个字在闪、一条尾巴能拉多长。
 *
 * 这一层决定的是「有几个 span 在动」—— 每个 token 起一条尾巴会让节点数跟着回复长度长，
 * 而这一行是常驻的；一条也不起则新字上来就直接是安静色，读不出「刚写下」。
 * 真机上的 DOM 只能看出结果，算不清中间那几帧，所以这里是纯函数测。
 */

const cold = (from: number): { readonly from: number; readonly at: number } => ({ from, at: 1 })

describe('墨迹尾巴的推进', () => {
  it('没有新字就不动账', () => {
    const current = cold(3)

    expect(nextInk(current, 5, 5, 10_000)).toBe(current)
    /* 长度回缩（句子被替换）同样不动。 */
    expect(nextInk(current, 5, 2, 10_000)).toBe(current)
  })

  it('冷却期内新到的字并进同一条尾巴', () => {
    const started = cold(2)
    const now = started.at + INK_MS / 2
    const grown = nextInk(started, 2, 6, now)

    /* 起点不动：尾巴还是那一条，只是更长。 */
    expect(grown).toEqual({ from: 2, at: started.at })
  })

  it('上一段冷却之后才另起一条，起点是这一轮渲染到的地方', () => {
    const started = cold(2)
    const now = started.at + INK_MS + 1
    const fresh = nextInk(started, 6, 9, now)

    expect(fresh).toEqual({ from: 6, at: now })
  })

  it('冷却的边界是闭区间：刚好到期算还没冷', () => {
    const started = cold(2)

    expect(nextInk(started, 2, 6, started.at + INK_MS)).toEqual(started)
    expect(nextInk(started, 2, 6, started.at + INK_MS + 1).from).toBe(2)
  })

  it('一批来很多字也只起一条尾巴：成批到达不该变成一批 span', () => {
    const started = cold(0)
    const now = started.at + 1

    expect(nextInk(started, 0, 40, now)).toEqual({ from: 0, at: started.at })
  })
})
