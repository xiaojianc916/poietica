/* 思考行真实布局检查的指标。纯函数：用手写的采样序列就能测（见 __tests__/ticker-layout.test.ts）。 */

export interface Sample {
  readonly t: number
  /** 当前句在原文里的起始偏移（组头的 lineKey 尾巴） */
  readonly key: number
  readonly shown: number
  /**
   * 到这一帧为止源文本已经到达到多少字。用来判断「这一帧还在出字」：屏幕上印到的位置还没追上
   * 已经到的位置；停笔之后句首本来就不该动，那种静止不是「应动未动」。
   */
  readonly arrived: number
  readonly firstL: number
  readonly lastR: number
  readonly winL: number
  readonly winR: number
  readonly winW: number
  readonly trackW: number
  /** offset / text / shownKey 都只用于回看，不参与判定。 */
  readonly offset: number
  readonly text?: string
  readonly shownKey?: string
}

export interface Arrival {
  readonly at: number
  readonly length: number
}

export interface Metrics {
  /** 最后一个字的右边界越过窗口右边界的帧数 */
  readonly rightClip: number
  readonly leftCutWhileFits: number
  readonly latency: readonly number[]
  readonly p50: number
  readonly p95: number
  readonly max: number
  /** 只在溢出、正在出字的帧里算 */
  readonly stallFrac: number
  readonly sJ90: number
}

/** 亚像素误差不算越界：与 ticker-engine 的 OVERFLOW_EPS_PX 同一个口径。 */
const EPS_PX = 0.5

function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0

  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))

  return sorted[index] ?? 0
}

/**
 * 每批到达的时刻，到这一批的第一个字出现在 DOM 里的时间（上一批的原文长度 + 1，再加上句子的起始偏移）。
 * 找不到就记 9999（超时）。
 */
function latencies(samples: readonly Sample[], arrivals: readonly Arrival[]): number[] {
  const out: number[] = []

  for (let index = 1; index < arrivals.length; index += 1) {
    const arrival = arrivals[index]
    const previous = arrivals[index - 1]

    if (arrival === undefined || previous === undefined) continue

    const need = previous.length + 1
    const hit = samples.find((sample) => sample.t >= arrival.at && sample.key + sample.shown >= need)

    out.push(hit === undefined ? 9999 : hit.t - arrival.at)
  }

  return out
}

/**
 * 这一对相邻帧算不算运动：同一句、正在溢出、屏幕还没追上到达的字、落在判定窗口里。
 * 停笔之后「该印的都印完了」的静止不算运动 —— 流里本来就会停顿（慢速档第 70 批之后停 1.5s），
 * 算进去就把正确行为记成缺陷。
 */
function isMovingPair(a: Sample, b: Sample, firstAt: number, lastAt: number): boolean {
  if (a.key !== b.key) return false
  if (b.trackW <= b.winW + EPS_PX || a.trackW <= a.winW + EPS_PX) return false
  if (b.key + b.shown >= b.arrived) return false

  return b.t - firstAt >= 300 && b.t <= lastAt
}

function stepOf(a: Sample, b: Sample): { readonly dx: number; readonly dt: number } {
  return { dx: b.firstL - a.firstL, dt: b.t - a.t }
}

function jitterOf(speeds: readonly number[]): number[] {
  const jitter: number[] = []

  for (let index = 1; index < speeds.length; index += 1) {
    const previous = speeds[index - 1]
    const current = speeds[index]

    if (previous === undefined || current === undefined) continue
    if (current > 50 && previous > 50) jitter.push(Math.abs(current - previous) / ((current + previous) / 2))
  }

  return jitter
}

/** 只算「同一句、正在溢出、正在出字」的相邻帧：换句那一跳与区间之外的静止都不算运动。 */
function speedJitter(
  samples: readonly Sample[],
  arrivals: readonly Arrival[],
): { readonly stallFrac: number; readonly sJ90: number } {
  const firstAt = arrivals[0]?.at ?? 0
  const lastAt = arrivals[arrivals.length - 1]?.at ?? 0
  const speeds: number[] = []
  let stalls = 0

  for (let index = 1; index < samples.length; index += 1) {
    const a = samples[index - 1]
    const b = samples[index]

    if (a === undefined || b === undefined) continue
    if (!isMovingPair(a, b, firstAt, lastAt)) continue

    const { dx, dt } = stepOf(a, b)

    if (Math.abs(dx) < 0.05) stalls += 1
    if (dt > 0) speeds.push(-dx / (dt / 1000))
  }

  return { stallFrac: speeds.length === 0 ? 0 : stalls / speeds.length, sJ90: percentile(jitterOf(speeds), 90) }
}

export function computeMetrics(samples: readonly Sample[], arrivals: readonly Arrival[]): Metrics {
  const rightClip = samples.filter((sample) => sample.lastR > sample.winR + EPS_PX).length
  const leftCutWhileFits = samples.filter(
    (sample) => sample.trackW <= sample.winW + EPS_PX && sample.firstL < sample.winL - EPS_PX,
  ).length
  const latency = latencies(samples, arrivals)
  const { stallFrac, sJ90 } = speedJitter(samples, arrivals)

  return {
    rightClip,
    leftCutWhileFits,
    latency,
    p50: percentile(latency, 50),
    p95: percentile(latency, 95),
    max: latency.length === 0 ? 0 : Math.max(...latency),
    stallFrac,
    sJ90,
  }
}

/**
 * 阈值表。数组里三档：默认、极快、少动效。
 * `null` 表示这一档不判定这一项，只把数报出来：极快档的顿挫是已知局限，给它定一个会失败的门槛，
 * 等于把「已知局限」变成「永远红的检查」。
 */
export interface Thresholds {
  readonly latencyP95Ms: number
  readonly stallFrac: number | null
  readonly sJ90: number | null
}

export const DEFAULT_THRESHOLDS: Thresholds = { latencyP95Ms: 500, stallFrac: 0.1, sJ90: 0.25 }
export const FAST_THRESHOLDS: Thresholds = { latencyP95Ms: 700, stallFrac: null, sJ90: null }
export const REDUCED_THRESHOLDS: Thresholds = { latencyP95Ms: 100, stallFrac: null, sJ90: null }

/** 返回失败项的说明；空数组就是过。 */
export function judge(metrics: Metrics, thresholds: Thresholds): readonly string[] {
  const failures: string[] = []

  if (metrics.rightClip !== 0) failures.push(`右侧裁到字的帧 ${String(metrics.rightClip)}（要求 0）`)
  if (metrics.leftCutWhileFits !== 0)
    failures.push(`放得下时句首被裁的帧 ${String(metrics.leftCutWhileFits)}（要求 0）`)
  if (metrics.p95 > thresholds.latencyP95Ms)
    failures.push(`新字出现延迟 p95 ${String(metrics.p95)}ms（要求 ≤ ${String(thresholds.latencyP95Ms)}ms）`)
  if (thresholds.stallFrac !== null && metrics.stallFrac > thresholds.stallFrac)
    failures.push(`应动未动的帧占比 ${metrics.stallFrac.toFixed(2)}（要求 ≤ ${thresholds.stallFrac.toFixed(2)}）`)
  if (thresholds.sJ90 !== null && metrics.sJ90 > thresholds.sJ90)
    failures.push(`平滑度 sJ90 ${metrics.sJ90.toFixed(2)}（要求 ≤ ${thresholds.sJ90.toFixed(2)}）`)

  return failures
}
