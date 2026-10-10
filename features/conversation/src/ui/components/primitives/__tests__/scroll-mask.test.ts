import { describe, expect, it } from 'bun:test'
import { resolveScrollMaskState } from '../use-scroll-mask'

/*
 * 两端那道雾的判据。
 *
 * 要紧的只有一件事：雾说的是「这一端还藏着没露出来的行」。所以没滚动时上端不能有雾
 * （上面就是第一行），滚到底时下端不能有雾（下面没有东西了），容得下全部内容时两端
 * 都不该有 —— 一个滚不动的盒子不该长出一条渐隐。
 */

describe('自己滚的盒子两端那道雾', () => {
  it('装得下全部内容时两端都没有雾', () => {
    expect(resolveScrollMaskState({ clientHeight: 320, scrollHeight: 320, scrollTop: 0 })).toBe('none')
    /* 差一两个像素（取整误差）不算「藏着」。 */
    expect(resolveScrollMaskState({ clientHeight: 320, scrollHeight: 321, scrollTop: 0 })).toBe('none')
  })

  it('停在顶端只有下端有雾；停在底端只有上端有雾', () => {
    const box = { clientHeight: 320, scrollHeight: 900 }

    expect(resolveScrollMaskState({ ...box, scrollTop: 0 })).toBe('bottom')
    expect(resolveScrollMaskState({ ...box, scrollTop: 580 })).toBe('top')
  })

  it('滚到中段两端都有雾', () => {
    expect(resolveScrollMaskState({ clientHeight: 320, scrollHeight: 900, scrollTop: 200 })).toBe('both')
  })

  it('端头那半个像素也要算到头，雾不能永远擦不掉', () => {
    /* scrollTop 是小数、另外两个是整数：不设容差，0.5 会被当成「还藏着一行」。 */
    expect(resolveScrollMaskState({ clientHeight: 320, scrollHeight: 900, scrollTop: 0.5 })).toBe('bottom')
    expect(resolveScrollMaskState({ clientHeight: 320, scrollHeight: 900, scrollTop: 579.5 })).toBe('top')
  })
})
