import { expect, test } from 'bun:test'
import { planWave, WAVE, waveSettledAt } from '../wave'

/* 流式节奏的唯一产地：回复正文（wave-reveal）与思考行（ticker-engine）都按这里切段、排时刻。 */

test('W1 只切 known 之后的新字，段首尾相接、盖满新字', () => {
  const text = '已经在屏幕上的字，然后是这一批新到的二十多个字，按段切开'
  const known = 9
  const { segments } = planWave(text, known, 1000, 0)

  expect(segments[0]?.from).toBe(known)
  expect(segments[segments.length - 1]?.to).toBe(text.length)
  for (let i = 1; i < segments.length; i++) expect(segments[i]?.from).toBe(segments[i - 1]?.to)
})

test('W2 段数 = ⌈字数 / minSegment⌉，封顶 maxSegments；各段长短至多差一个字', () => {
  const lengths = (count: number) => planWave('字'.repeat(count), 0, 0, 0).segments.map((s) => s.to - s.from)

  expect(lengths(3)).toEqual([3])
  expect(lengths(40)).toHaveLength(Math.ceil(40 / WAVE.minSegment))
  expect(lengths(1000)).toHaveLength(WAVE.maxSegments)
  expect(Math.max(...lengths(40)) - Math.min(...lengths(40))).toBeLessThanOrEqual(1)
})

test('W3 段与段错开 stepMs 起淡，整波铺开不超过 spreadMs', () => {
  const { segments } = planWave('字'.repeat(1000), 0, 500, 0)
  const starts = segments.map((segment) => segment.start)

  expect(starts[0]).toBe(500)
  for (let i = 1; i < starts.length; i++)
    expect((starts[i] ?? 0) - (starts[i - 1] ?? 0)).toBeLessThanOrEqual(WAVE.stepMs)
  expect((starts[starts.length - 1] ?? 0) - 500).toBeLessThanOrEqual(WAVE.spreadMs)
})

test('W4 跨批首尾相接：下一批接在 cursor 后面，但积压不超过 spreadMs', () => {
  const first = planWave('字'.repeat(12), 0, 1000, 0)
  const next = planWave('字'.repeat(18), 12, 1001, first.cursor)
  const late = planWave('字'.repeat(18), 12, 1001, 1001 + 10 * WAVE.spreadMs)

  expect(first.cursor).toBe(1000 + 2 * WAVE.stepMs)

  expect(next.segments[0]?.start).toBe(first.cursor)
  expect(late.segments[0]?.start).toBe(1001 + WAVE.spreadMs)
})

test('W5 不把一个字素切成两半（emoji 的代理对、组合符）', () => {
  const text = '看👍🏽这个é'
  const { segments } = planWave(text, 0, 0, 0, { ...WAVE, minSegment: 1 })
  const cuts = segments.map((segment) => text.slice(segment.from, segment.to))

  expect(cuts.join('')).toBe(text)
  expect(cuts).toContain('👍🏽')
})

test('W6 没有新字：不出段、cursor 原样返回；淡完时刻 = 起点 + fadeMs + 余量', () => {
  expect(planWave('一样', 2, 100, 42)).toEqual({ segments: [], cursor: 42, busyUntil: 0 })
  expect(waveSettledAt({ from: 0, to: 1, start: 100 })).toBe(100 + WAVE.fadeMs + WAVE.settleMarginMs)
})
