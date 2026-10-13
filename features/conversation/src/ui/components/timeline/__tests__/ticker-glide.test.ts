import { describe, expect, test } from 'bun:test'
import { AT_REST, type GlideState, glideStep, noteShift, type Shift, shiftRate } from '../ticker/ticker-glide'

const FRAME = 1000 / 60
const EM = 14
const TAIL = 35

/** 模拟放字：放字那刻 o += 字宽（布局左移由 o 抵消），其后逐帧滑；返回每帧视觉位移与 o。 */
function simulate(charEvery: number, charWidth: number, until: number, stopAt = Infinity) {
  let state: GlideState = AT_REST
  let shifts: Shift[] = []
  let layout = 0
  let nextChar = charEvery
  const frames: { at: number; visual: number; o: number }[] = []

  for (let now = 0; now <= until; now += FRAME) {
    while (nextChar <= now && nextChar <= stopAt) {
      layout += charWidth
      shifts = noteShift(shifts, nextChar, charWidth)
      state = { o: Math.min(TAIL, state.o + charWidth), v: state.v }
      nextChar += charEvery
    }
    state = glideStep(state, shiftRate(shifts, now), EM, TAIL, FRAME)
    frames.push({ at: now, visual: layout - state.o, o: state.o })
  }

  return frames
}

describe('glideStep', () => {
  test('匀速出字：起步 300ms 后每帧都在动，相邻两帧速度变化 ≤ 20%', () => {
    const frames = simulate(33, 14, 3000).filter((frame) => frame.at > 300)

    for (let index = 2; index < frames.length; index += 1) {
      const v1 = (frames[index - 1]?.visual ?? 0) - (frames[index - 2]?.visual ?? 0)
      const v2 = (frames[index]?.visual ?? 0) - (frames[index - 1]?.visual ?? 0)
      expect(v2).toBeGreaterThan(0)
      expect(Math.abs(v2 - v1) / ((v1 + v2) / 2)).toBeLessThanOrEqual(0.2)
    }
  })

  test('o 永远在 [0, tail] 内：最新的字越不过右边缘', () => {
    for (const frame of simulate(20, 14, 3000)) {
      expect(frame.o).toBeGreaterThanOrEqual(0)
      expect(frame.o).toBeLessThanOrEqual(TAIL)
    }
  })

  test('停笔：最后一个字之后 600ms 内滑完（o 归零），且从不往回滑', () => {
    const frames = simulate(33, 14, 2500, 1500)
    const after = frames.filter((frame) => frame.at > 2100)
    expect(after.every((frame) => frame.o === 0)).toBe(true)
    for (let index = 1; index < frames.length; index += 1) {
      expect((frames[index]?.visual ?? 0) - (frames[index - 1]?.visual ?? 0)).toBeGreaterThanOrEqual(-1e-9)
    }
  })

  test('静止且没有推进：保持不动', () => {
    expect(glideStep(AT_REST, 0, EM, TAIL, FRAME)).toEqual(AT_REST)
  })
})
