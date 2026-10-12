/*
 * 电子屏那一下「划」的数学。
 *
 * 追速度，不追位置。token 是成批到达的，目标位移因此是一级一级的台阶；直接追台阶（指数
 * 逼近）会在每批到达时猛冲一下再减速，看起来一抽一抽。所以先估出出字速度，让划动按这个
 * 速度匀速走，再用「滞后量与设定值的偏差」慢慢校正。速度本身也做平滑：画面上只有速度的
 * 连续变化，没有加速度的突变 —— 这就是「丝滑」和「跟上 token 速度」两件事的同一个答案。
 *
 * 这里只有数学，没有 DOM：真机上量不到宽度、也摆不出逐帧的时序，几何与时序要能在
 * 纯函数里被测（见 __tests__/marquee-model.test.ts）。
 */

export interface MarqueeGeometry {
  /** 当前句的自然宽度（px） */
  readonly content: number
  /** 窗口宽度（px） */
  readonly viewport: number
  /** 尾部留白（px）= TAIL_EM × 字号 */
  readonly tail: number
}

export interface MarqueeState {
  /** 当前位移（px，向左为正） */
  readonly x: number
  /** 当前速度（px/s） */
  readonly v: number
}

export interface RateSample {
  /** 时刻（ms） */
  readonly at: number
  /** 那一刻的目标位移（px） */
  readonly target: number
}

/**
 * 静止时最新的字与右边缘之间的空白，也是滑动中滞后的上限。
 *
 * 1.5 不够：每秒 30 字、50ms 一批时一批就有 1.5 个字，滞后会顶到边缘把最新的字推到窗外。
 */
export const TAIL_EM = 2

/** 出字期间希望保持的滞后：留半个字吸收成批到达。 */
export const LAG_SET_EM = 0.5

/** 出字速度按最近这么久的位移增量估计，窗口平均比逐次估计稳。 */
export const RATE_WINDOW_MS = 600

/** 滞后偏离设定值时用多久纠正回来；也决定停笔后减速停稳的快慢。 */
export const CORRECT_MS = 300

/** 速度本身的平滑时间常数：速度连续变化，没有加速度突变。 */
export const VELOCITY_SMOOTH_MS = 120

/** 追赶速度上限：新句一出场就已超宽时，不至于「嗖」地一下划走。 */
export const MAX_CATCHUP_PX_S = 900

/** 落后超过窗口宽的这么多就先跳近（快模型一批来很多字、后台切回）。 */
export const SNAP_LAG_RATIO = 0.6

/** 跳近后仍保留窗口宽这么多让它滑完，不是瞬移到位。 */
export const SNAP_KEEP_RATIO = 0.15

/** 位置差不到半像素、速度也几乎为零，才算到位。 */
export const SETTLE_EPS_PX = 0.5

export const SETTLE_SPEED_PX_S = 4

/** 单帧时间步上限：标签页从后台切回时不一步跳过头。 */
export const MAX_DT_MS = 64

/** 目标位移：整句宽度加上尾部留白，多出窗口的那一截就是要划的距离。 */
export function targetOffset(g: MarqueeGeometry): number {
  return Math.max(0, g.content + g.tail - g.viewport)
}

/**
 * 出字速度 = 最近 RATE_WINDOW_MS 内目标位移的增量 ÷ 时长。
 *
 * 按窗口平均而不是逐次估计：token 到达的间隔很不均匀，逐次估计的速度会跟着抖。分母至少
 * 120ms —— 刚起步时两个样本挨得太近，速度会被估得离谱。调用方维护样本数组，只保留窗口内
 * 的样本。
 */
export function rateOf(samples: readonly RateSample[], now: number): number {
  const recent = samples.filter((sample) => now - sample.at <= RATE_WINDOW_MS)
  const first = recent[0]
  const last = recent[recent.length - 1]

  if (first === undefined || last === undefined || recent.length < 2) {
    return 0
  }

  return (Math.max(0, last.target - first.target) / Math.max(now - first.at, 120)) * 1000
}

/**
 * 走一帧。
 *
 * 调用的顺序有讲究（见 use-marquee）：先 `rateOf` 估速度，再 `step` 推进，最后
 * `clampToTail` 兜底 —— 安全底线放在最后，任何一步算出来的位置都越不过它。
 */
export function step(s: MarqueeState, target: number, rate: number, dtMs: number, g: MarqueeGeometry): MarqueeState {
  /* 目标后退（窗口变宽、句子被替换）：直接到位，不往回滑 —— 往回滑读起来像倒带。 */
  if (target <= s.x) {
    return { x: target, v: 0 }
  }

  const lag = target - s.x

  /* 落后太多：先跳近，留一小段继续滑，不是瞬移。 */
  if (lag > g.viewport * SNAP_LAG_RATIO) {
    return { x: target - g.viewport * SNAP_KEEP_RATIO, v: s.v }
  }

  const dt = Math.min(dtMs, MAX_DT_MS)
  /* 还在出字时留半个字的滞后吸收成批到达；停笔后设定值归零，只剩校正项，于是自然减速停稳。 */
  const setPoint = rate > 0 ? LAG_SET_EM * (g.tail / TAIL_EM) : 0
  const wanted = Math.min(rate + (lag - setPoint) / (CORRECT_MS / 1000), MAX_CATCHUP_PX_S)
  const v = Math.max(0, s.v + (wanted - s.v) * (1 - Math.exp(-dt / VELOCITY_SMOOTH_MS)))

  return { x: Math.min(target, s.x + (v * dt) / 1000), v }
}

/**
 * 位置差不到半像素、速度也几乎为零，才算到位。
 *
 * 只看位置会在减速的尾段提前停下，留下一小截没走完 —— 而那一小截正是最新的字。
 */
export function isSettled(s: MarqueeState, target: number): boolean {
  return target - s.x < SETTLE_EPS_PX && s.v < SETTLE_SPEED_PX_S
}

/**
 * 安全底线：最新的字的右缘不得越过窗口右缘。
 *
 * 只有快模型会碰到它，碰到时宁可跳一下也不遮字。它同时兜住「尾部留白」这条视觉承诺：
 * 目标位移已经把留白算进去了（`targetOffset`），所以卡在 `target - tail` 上就等于
 * 「最新的字离右边缘还有 tail」。
 */
export function clampToTail(x: number, target: number, tail: number): number {
  return Math.max(x, target - tail)
}
