import { describe, expect, it } from 'vitest'
import { atEnd, followsGrowth, intentAtRest, pinDelta } from '../scroll-authority'

/* 判据是纯的，所以能脱离 DOM 钉住 —— jsdom 的 scrollHeight 与 clientHeight 恒为 0。 */
const AT_END = { clientHeight: 600, scrollHeight: 1000, scrollTop: 400 }
const FAR = { ...AT_END, scrollTop: 100 }

describe('atEnd', () => {
  it('holds when the box sits at the end', () => {
    expect(atEnd(AT_END)).toBe(true)
  })

  it('still holds one wheel notch away', () => {
    expect(atEnd({ ...AT_END, scrollTop: 352 })).toBe(true)
  })

  it('lets go one pixel past that notch', () => {
    expect(atEnd({ ...AT_END, scrollTop: 351 })).toBe(false)
  })

  it('holds when the content does not overflow', () => {
    expect(atEnd({ clientHeight: 600, scrollHeight: 600, scrollTop: 0 })).toBe(true)
  })

  it('holds while the box rubber-bands past the end', () => {
    expect(atEnd({ ...AT_END, scrollTop: 500 })).toBe(true)
  })
})

describe('followsGrowth', () => {
  it('does not follow a commit that grew nothing', () => {
    expect(followsGrowth('tail', 1000, 1000)).toBe(false)
  })

  it('follows content that grew while still latched', () => {
    expect(followsGrowth('tail', 1200, 1000)).toBe(true)
  })

  it('does not follow content that grew under a reader who left', () => {
    expect(followsGrowth('free', 1200, 1000)).toBe(false)
  })

  it('does not follow while a travel is under way', () => {
    expect(followsGrowth('glide', 1200, 1000)).toBe(false)
  })

  it('takes the first content it ever sees', () => {
    expect(followsGrowth('tail', 0, -1)).toBe(true)
  })
})

describe('intentAtRest', () => {
  it('latches again once the reader stops at the end', () => {
    expect(intentAtRest('free', AT_END)).toBe('tail')
  })

  it('stays let go while the reader rests far from the end', () => {
    expect(intentAtRest('free', FAR)).toBe('free')
  })

  it('never interrupts a travel', () => {
    expect(intentAtRest('glide', AT_END)).toBe('glide')
  })
})

describe('pinDelta', () => {
  it('reports the distance back to the held row', () => {
    expect(pinDelta(400, 460)).toBe(60)
  })

  it('pins upward under the same rule', () => {
    expect(pinDelta(460, 400)).toBe(-60)
  })

  it('reports nothing left to do inside half a pixel', () => {
    expect(pinDelta(400, 400.4)).toBe(null)
  })
})
