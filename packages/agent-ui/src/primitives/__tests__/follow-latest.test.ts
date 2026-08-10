import { describe, expect, it } from 'vitest'
import { distanceFromEnd, staysWithLatest } from '../follow-latest'

/*
 * 判据是纯的，所以它能脱离 DOM 单独钉住 —— 这也是把它从 hook 里分出来的理由：jsdom 的
 * scrollHeight 与 clientHeight 恒为 0，留在组件里就永远测不到这几种几何。
 */
describe('follow-latest', () => {
  it('reads the distance straight off one box', () => {
    expect(distanceFromEnd({ clientHeight: 600, scrollHeight: 1000, scrollTop: 400 })).toBe(0)
  })

  it('stays with the latest when the box sits at the end', () => {
    expect(staysWithLatest({ clientHeight: 600, scrollHeight: 1000, scrollTop: 400 })).toBe(true)
  })

  it('still counts as latest one wheel notch away', () => {
    expect(staysWithLatest({ clientHeight: 600, scrollHeight: 1000, scrollTop: 352 })).toBe(true)
  })

  it('lets go one pixel past that notch', () => {
    expect(staysWithLatest({ clientHeight: 600, scrollHeight: 1000, scrollTop: 351 })).toBe(false)
  })

  it('counts as latest when the content does not overflow', () => {
    expect(staysWithLatest({ clientHeight: 600, scrollHeight: 600, scrollTop: 0 })).toBe(true)
  })

  it('counts as latest while the box rubber-bands past the end', () => {
    expect(staysWithLatest({ clientHeight: 600, scrollHeight: 1000, scrollTop: 500 })).toBe(true)
  })
})
