import { describe, expect, it } from 'vitest'
import { easeOut, glideStep } from '../scroll-glide'

describe('easeOut', () => {
  it('starts at the origin and lands on the target', () => {
    expect(easeOut(0)).toBe(0)
    expect(easeOut(1)).toBe(1)
  })

  it('spends most of the distance early', () => {
    expect(easeOut(0.5)).toBe(0.875)
  })
})

describe('glideStep', () => {
  /* 目标每帧由调用方重算传入：行被测量、内容长高都只是挪终点,不该把这一段打断。 */
  it('interpolates toward the target it is given', () => {
    expect(glideStep(100, 100, 3400, 0.5)).toBe(2987.5)
  })

  it('follows a target that moved while the glide was under way', () => {
    expect(glideStep(100, 100, 4400, 0.5)).toBe(3862.5)
  })

  it('reports the glide done when the budget runs out', () => {
    expect(glideStep(100, 900, 3400, 1)).toBe(null)
  })

  it('reports the glide done once the target sits behind the travel', () => {
    expect(glideStep(100, 400, 300, 0.5)).toBe(null)
  })

  /* 回归：位移途中任何一次逆行写入都是一下可见的抽动。 */
  it('never steps back against a downward glide', () => {
    expect(glideStep(100, 3000, 3400, 0.1)).toBe(3000)
  })

  it('glides upward under the same rule', () => {
    expect(glideStep(1000, 1000, 200, 0.5)).toBe(300)
  })

  it('never steps forward against an upward glide', () => {
    expect(glideStep(1000, 250, 200, 0.1)).toBe(250)
  })
})
