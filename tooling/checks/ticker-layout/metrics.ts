/*
 * 思考行真实布局检查的指标（§8.4）。
 *
 * 纯函数：用手写的采样序列就能测（见 __tests__/ticker-layout.test.ts），不用真起 Electron。
 * 采样与到达序列的形状在这里定义，两端（recorder 与 run）都照它写。
 */

/** 一帧的测量：绘制完成之后取的那一次。 */
export interface Sample {
  readonly t: number
  /** 当前句在原文里的起始偏移（组头的 lineKey 尾巴） */
  readonly key: number
  /** 当前句在屏幕上已经印出来的字数 */
  readonly shown: number
  /**
   * 到这一帧为止源文本已经到达到多少字（§8.4 要求 recorder 记的一项）。
   *
   * 用来判断「这一帧还在出字」：判据是屏幕上印到的位置还没追上已经到的位置。停笔之后
   * 「该印的都印完了」，句首本来就不该动，那种静止不是「应动未动」。
   */
  readonly arrived: number
  /** 第一个字的左边界 */
  readonly firstL: number
  /** 最后一个非空白字的右边界 */
  readonly lastR: number
  readonly winL: number
  readonly winR: number
  readonly winW: number
  readonly trackW: number
  /** 轨道当时的位移 o（px，从 transform 里解析）。判定不用它，只用于回看。 */
  readonly offset: number
  /** 这一帧轨道里实际印着的文本。判定不用它，只用于回看原始采样时对账。 */
  readonly text?: string
  /** 这一帧屏幕上那一格的 `data-line-key`（显示中的句子身份）。同样只用于回看。 */
  readonly shownKey?: string
}

/** 一批 token 到达：这批到的时候整句有多长（原文长度）。 */
export interface Arrival {
  readonly at: number
  readonly length: number
}

export interface Metrics {
  /** 右侧裁到字的帧数：最后一个字的右边界越过了窗口右边界 */
  readonly rightClip: number
  /** 放得下时句首被裁的帧数 */
  readonly leftCutWhileFits: number
  /** 新字出现延迟（ms），按到达顺序 */
  readonly latency: readonly number[]
  readonly p50: number
  readonly p95: number
  readonly max: number
  /** 应动未动的帧占比（只在溢出、正在出字的帧里算） */
  readonly stallFrac: number
  /** 相邻两帧视觉速度相对变化的第 90 百分位 */
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
 * 每批到达的时刻，到这一批的第一个字出现在 DOM 里的时间。
 *
 * 「这一批的第一个字」= 上一批的原文长度 + 1；当前句只印它自己那一段，所以要把句子的起始
 * 偏移加回去：屏幕上印出 shown 个字，等于印到 offset + shown。找不到就记 9999（超时）。
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
 *
 * 换句那一跳（key 变了）、不溢出的静止、停笔之后「该印的都印完了」的静止、窗口之外的帧
 * 都不是「运动」。最后一条是 §8.4 表格里写的「正在出字时」：流里本来就可能停顿（慢速档
 * 第 70 批之后停 1.5s），停下来时句首当然不动，算进去就把正确行为记成缺陷。
 */
function isMovingPair(a: Sample, b: Sample, firstAt: number, lastAt: number): boolean {
  if (a.key !== b.key) return false
  if (b.trackW <= b.winW + EPS_PX || a.trackW <= a.winW + EPS_PX) return false
  if (b.key + b.shown >= b.arrived) return false

  return b.t - firstAt >= 300 && b.t <= lastAt
}

/** 一对相邻帧的位移与时长。 */
function stepOf(a: Sample, b: Sample): { readonly dx: number; readonly dt: number } {
  return { dx: b.firstL - a.firstL, dt: b.t - a.t }
}

/** 相邻两帧视觉速度的相对变化（只计两帧都在动的）。 */
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

/**
 * 视觉速度与相邻帧速度变化。
 *
 * 只算「同一句、正在溢出、正在出字」的相邻帧：换句那一跳、以及区间之外的静止都不算运动。
 */
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
 * 阈值表（§8.4）。数组里三档：默认、极快、少动效。
 *
 * `null` 表示这一档不判定这一项，只把数报出来：§8.4 的表格里「应动未动」「sJ90」只对
 * 匀速 / 成批 / 慢速 / 拖窄四档给了阈值，而 §10 已把极快档的顿挫列为已知局限、不在本次
 * 范围内。给它定一个会失败的门槛，等于把「已知局限」变成「永远红的检查」。
 *
 * 返回失败项的说明；空数组就是过。
 */
export interface Thresholds {
  readonly latencyP95Ms: number
  readonly stallFrac: number | null
  readonly sJ90: number | null
}

export const DEFAULT_THRESHOLDS: Thresholds = { latencyP95Ms: 500, stallFrac: 0.1, sJ90: 0.25 }
export const FAST_THRESHOLDS: Thresholds = { latencyP95Ms: 700, stallFrac: null, sJ90: null }
export const REDUCED_THRESHOLDS: Thresholds = { latencyP95Ms: 100, stallFrac: null, sJ90: null }

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
