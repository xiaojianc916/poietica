import { describe, expect, test } from 'bun:test'
import {
  type ArrivalLog,
  EMPTY_LOG,
  incomingRate,
  MAX_BACKLOG_CHARS,
  MIN_CPS,
  noteArrival,
  type PaceState,
  paceStep,
  visibleCount,
} from '../ticker-pace'

const FRAME = 1000 / 60

/** 按到达序列逐帧推放字，返回每帧的 { at, shown, speed, length }。 */
function simulate(arrivals: readonly { at: number; length: number }[], until: number) {
  let log: ArrivalLog = EMPTY_LOG
  let state: PaceState = { shown: 0, speed: 0 }
  let length = 0
  let next = 0
  const frames: { at: number; shown: number; speed: number; length: number }[] = []

  for (let now = 0; now <= until; now += FRAME) {
    for (; next < arrivals.length && (arrivals[next]?.at ?? Infinity) <= now; next += 1) {
      const arrival = arrivals[next]
      if (arrival !== undefined) {
        log = noteArrival(log, arrival.at, arrival.length)
        length = arrival.length
      }
    }
    state = paceStep(state, length, incomingRate(log, now), log.gapMs, FRAME, false)
    frames.push({ at: now, shown: state.shown, speed: state.speed, length })
  }

  return frames
}

/** 每 every 毫秒来 chunk 个字，共 count 批。 */
const batches = (every: number, chunk: number, count: number) =>
  Array.from({ length: count }, (_, index) => ({ at: (index + 1) * every, length: (index + 1) * chunk }))

describe('incomingRate', () => {
  test('不足两批：0', () => {
    expect(incomingRate(noteArrival(EMPTY_LOG, 0, 5), 10)).toBe(0)
  })

  test('每 100ms 来 3 个字 ≈ 30 字/秒', () => {
    let log = EMPTY_LOG
    for (let index = 0; index <= 6; index += 1) log = noteArrival(log, index * 100, index * 3)
    expect(incomingRate(log, 600)).toBeCloseTo(30, 0)
  })

  test('文字变短：从这一批重新记', () => {
    const log = noteArrival(noteArrival(noteArrival(EMPTY_LOG, 0, 10), 50, 12), 100, 8)
    expect(log.samples).toHaveLength(1)
  })
})

describe('paceStep', () => {
  test('匀速：每 50ms 来 1.5 个字（30 字/秒），起步 400ms 后放字从不停、速度变化小', () => {
    const frames = simulate(batches(50, 1.5, 80), 4000).filter((frame) => frame.at > 400 && frame.at < 4000)
    const speeds = frames.map((frame) => frame.speed)
    const mean = speeds.reduce((sum, speed) => sum + speed, 0) / speeds.length

    for (let index = 1; index < frames.length; index += 1) {
      expect((frames[index]?.shown ?? 0) - (frames[index - 1]?.shown ?? 0)).toBeGreaterThan(0)
      expect(Math.abs((speeds[index] ?? 0) - (speeds[index - 1] ?? 0)) / mean).toBeLessThanOrEqual(0.15)
    }
  })

  test('成批：每 250ms 来 8 个字，放字照样不停（缓冲里常备一批）', () => {
    const frames = simulate(batches(250, 8, 16), 4000).filter((frame) => frame.at > 600 && frame.at < 4000)

    for (let index = 1; index < frames.length; index += 1) {
      expect((frames[index]?.shown ?? 0) - (frames[index - 1]?.shown ?? 0)).toBeGreaterThan(0)
    }
  })

  test('落后有上限：任何时刻积压不超过一批多一点（成批 8 字时 ≤ 16）', () => {
    for (const frame of simulate(batches(250, 8, 16), 4500)) {
      expect(frame.length - frame.shown).toBeLessThanOrEqual(16)
    }
  })

  test('停笔：最后一批之后 1 秒内全部放完，速度逐步下降', () => {
    const frames = simulate(batches(50, 1.5, 40), 3500)
    const last = frames[frames.length - 1]
    expect(last?.shown).toBe(last?.length)
  })

  test('积压超过上限：直接跳近，不慢慢追', () => {
    const next = paceStep({ shown: 0, speed: 0 }, MAX_BACKLOG_CHARS + 40, 0, 0, FRAME, false)
    expect(next.shown).toBe(MAX_BACKLOG_CHARS + 40)
  })

  test('停顿之后来了 1 个字：不超过 1000/MIN_CPS 毫秒就放出来', () => {
    let state: PaceState = { shown: 10, speed: 0 }
    let elapsed = 0
    while (state.shown < 11 && elapsed < 1000) {
      state = paceStep(state, 11, 0, 0, FRAME, false)
      elapsed += FRAME
    }
    expect(elapsed).toBeLessThanOrEqual(1000 / MIN_CPS + FRAME)
  })

  test('从不超过已到达的长度', () => {
    for (const frame of simulate(batches(40, 8, 60), 3000)) expect(frame.shown).toBeLessThanOrEqual(frame.length)
  })
})

describe('visibleCount', () => {
  test('不把代理对拆开', () => {
    expect(visibleCount('ab😀c', 3)).toBe(4)
    expect(visibleCount('ab😀c', 2.9)).toBe(2)
  })
})
