/*
 * 思考行的「滑」：把每放出一个字带来的那一下布局位移，摊成连续的运动。
 *
 * 布局负责「对」：轨道在窗口里右对齐（见 rolling-line.css），放出一个字，整行在布局上立刻
 * 往左挪一个字宽，最新的字永远在右边缘以内。这里负责「顺」：那一刻先把轨道往右补回同样的
 * 距离（o 增加一个字宽，写成 transform），再按布局推进的速度把 o 匀速放回 0。
 *
 * 所以 o 只是「还没滑完的那一点」，被 tail 封顶：轨道右侧留着 tail 那么宽的空，o 不超过它，
 * 最新的字就越不过右边缘。逐帧引擎坏了，最坏也只是「不顺」，不会遮字。
 *
 * 纯函数，不碰 DOM。
 */

/**
 * 轨道右侧留白（em）。静止时最新的字离右边缘这么远，也是 o 的上限。
 *
 * 2.5 而不是 2：o 的设定值是 1em（见 SET_EM），一个汉字 1em 宽，o 在 [设定值 − 半字, 设定值 + 一字] 里
 * 摆动；从英文切到中文那一下还要多吃半个字的估计误差。2em 在实测里会顶到上限，顶到就是一跳。
 */
export const TAIL_EM = 2.5

/**
 * 滑行中希望保持的 o（em）：约一个字。
 *
 * 每放出一个字 o 涨一个字宽、随后匀速放掉，o 是锯齿。设定值低于半个字宽时锯齿的谷底会碰到 0 ——
 * 碰到 0 就没有可滑的了，画面停一帧，读出来就是抖。一个字宽让谷底离 0 还有半个字。
 */
export const SET_EM = 1

/** 估计布局推进速度用最近这么久的位移记录。 */
export const SHIFT_WINDOW_MS = 400

/** 速度估计的分母下限。 */
export const SHIFT_MIN_SPAN_MS = 200

/** o 偏离设定值时用多久纠正。 */
export const CORRECT_MS = 300

/** 滑行速度本身的平滑时间常数。 */
export const SPEED_SMOOTH_MS = 150

/** 滑行速度上限（px/s）。 */
export const MAX_PX_S = 1600

/** 停笔后最后那一点的最低速度（px/s）：不至于在最后半像素上爬很久。 */
export const SETTLE_PX_S = 20

/** 单帧时间步上限：标签页从后台切回时不一步跳过头。 */
export const MAX_DT_MS = 64

export interface Shift {
  readonly at: number
  readonly dx: number
}

export interface GlideState {
  /** 轨道相对布局位置往右补了多少（px，≥ 0） */
  readonly o: number
  /** 滑行速度（px/s） */
  readonly v: number
}

export const AT_REST: GlideState = { o: 0, v: 0 }

export function noteShift(shifts: readonly Shift[], at: number, dx: number): Shift[] {
  return [...shifts, { at, dx }].filter((shift) => at - shift.at <= SHIFT_WINDOW_MS)
}

/** 布局最近每秒往左推进多少像素。 */
export function shiftRate(shifts: readonly Shift[], now: number): number {
  const recent = shifts.filter((shift) => now - shift.at <= SHIFT_WINDOW_MS)
  const first = recent[0]

  if (first === undefined) return 0

  const total = recent.reduce((sum, shift) => sum + shift.dx, 0)

  return (total / Math.max(now - first.at, SHIFT_MIN_SPAN_MS)) * 1000
}

/**
 * 推一帧。滑行速度跟着布局推进的速度走，再用 o 与设定值的偏差校正；o 不出 [0, tail]。
 *
 * o 落到 0 而布局还在推进时保留速度：下一个字马上就来，速度归零再起步就是一顿一顿。
 */
export function glideStep(state: GlideState, pxRate: number, em: number, tail: number, dtMs: number): GlideState {
  if (state.o <= 0 && pxRate === 0) return AT_REST

  const setPoint = pxRate > 0 ? SET_EM * em : 0
  const wanted = Math.min(Math.max(0, pxRate + (state.o - setPoint) / (CORRECT_MS / 1000)), MAX_PX_S)
  const smoothed = state.v + (wanted - state.v) * (1 - Math.exp(-dtMs / SPEED_SMOOTH_MS))
  const v = pxRate === 0 && state.o > 0 ? Math.max(smoothed, SETTLE_PX_S) : smoothed
  const o = Math.min(tail, Math.max(0, state.o - (v * dtMs) / 1000))

  return { o, v: o === 0 && pxRate === 0 ? 0 : v }
}
