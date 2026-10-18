/*
 * 流式文字的「批次波浪」节奏：一批新到的字怎么切成小段、每段何时起淡。纯函数，时间由调用方传入。
 *
 * 回复正文（wave-reveal.ts，hast 上打标记）与思考行（ticker-engine.ts，直接写 DOM）是两种落点，
 * 节奏只有这一份：同一批字在两处切得一样、起得一样、淡得一样。谁要调「流式的手感」只改这里。
 */

export interface WaveOptions {
  readonly fadeMs: number
  readonly stepMs: number
  /** 一批的波最多铺开多久，也是跨批排队的积压上限 */
  readonly spreadMs: number
  readonly minSegment: number
  readonly maxSegments: number
  /** 一批超过 hugeBatch 个字素（如从后台切回）：只给最后 hugeTail 个做动画，前面的直接实显 */
  readonly hugeBatch: number
  readonly hugeTail: number
  readonly settleMarginMs: number
  /** 一次提交里最多新起 maxFreshPerCommit 个动画，超出的直接实显 —— 从后台切回时不让整屏一起淡 */
  readonly maxFreshPerCommit: number
}

export const WAVE: WaveOptions = {
  fadeMs: 320,
  stepMs: 30,
  spreadMs: 240,
  minSegment: 6,
  maxSegments: 24,
  hugeBatch: 1500,
  hugeTail: 600,
  settleMarginMs: 80,
  maxFreshPerCommit: 64,
}

export interface WaveSegment {
  readonly from: number
  readonly to: number
  /** 绝对启动时刻（performance.now 时基，与 document.timeline 同源） */
  readonly start: number
}

export interface WavePlan {
  readonly segments: readonly WaveSegment[]
  /** 下一批最早何时起：跨批共用，让波首尾相接 */
  readonly cursor: number
  /** 这一批最后一段淡完的时刻；没有新段时为 0 */
  readonly busyUntil: number
}

let segmenter: Intl.Segmenter | undefined

function graphemeEdges(text: string, base: number): number[] {
  segmenter ??= new Intl.Segmenter(undefined, { granularity: 'grapheme' })
  const edges: number[] = []
  for (const { index } of segmenter.segment(text.slice(base))) edges.push(base + index)
  edges.push(text.length)
  return edges
}

/** 一段淡完（含余量）的时刻：过了它，这一段就可以并回不带动画的正文。 */
export const waveSettledAt = (segment: WaveSegment, options: WaveOptions = WAVE): number =>
  segment.start + options.fadeMs + options.settleMarginMs

/**
 * 把 `text` 里 `known` 之后的新字切成小段并排上启动时刻：接在上一波（cursor）后面，但积压不超过 spreadMs ——
 * 宁可两波重叠，也不让字迟迟不出。
 */
export function planWave(
  text: string,
  known: number,
  t: number,
  cursor: number,
  options: WaveOptions = WAVE,
): WavePlan {
  let edges = graphemeEdges(text, known)
  if (edges.length - 1 > options.hugeBatch) edges = edges.slice(edges.length - 1 - options.hugeTail)
  const count = edges.length - 1
  if (count <= 0) return { segments: [], cursor, busyUntil: 0 }
  const pieces = Math.min(options.maxSegments, Math.ceil(count / options.minSegment))
  const step = pieces > 1 ? Math.min(options.stepMs, options.spreadMs / (pieces - 1)) : 0
  const first = Math.min(Math.max(cursor, t), t + options.spreadMs)
  const segments: WaveSegment[] = []
  for (let j = 0; j < pieces; j++) {
    const from = edges[Math.floor((j * count) / pieces)]!
    const to = edges[Math.floor(((j + 1) * count) / pieces)]!
    if (to > from) segments.push({ from, to, start: first + j * step })
  }
  return {
    segments,
    cursor: first + pieces * step,
    busyUntil: first + (pieces - 1) * step + options.fadeMs + options.settleMarginMs,
  }
}
