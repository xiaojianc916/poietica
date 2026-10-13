/*
 * 思考行的「滑」：布局负责「对」（放出一个字，整行立刻左挪一个字宽），这里负责「顺」—— 先把轨道往右补回同样的距离（transform 里的 o），再按布局推进的速度把 o 放回 0。
 * o 只是「还没滑完的那一点」，被 tail 封顶；逐帧引擎坏了最坏也只是「不顺」，不会遮字。纯函数，不碰 DOM。
 */

/**
 * 2.5 而不是 2：o 在 [设定值 − 半字, 设定值 + 一字] 里摆动，从英文切到中文还要多吃半个字的估计误差；2em 实测会顶到上限，顶到就是一跳。
 */
export const TAIL_EM = 2.5

/**
 * 每放出一个字 o 涨一个字宽、随后匀速放掉，o 是锯齿；设定值低于半个字宽时锯齿的谷底会碰到 0，碰到 0 就没得滑，画面停一帧，读出来就是抖。
 */
export const SET_EM = 1

/** 估计布局推进速度用的窗口。 */
export const SHIFT_WINDOW_MS = 400

export const SHIFT_MIN_SPAN_MS = 200

export const CORRECT_MS = 300

export const SPEED_SMOOTH_MS = 150

export const MAX_PX_S = 1600

/** 停笔后的最低速度：否则会在最后半像素上爬很久。 */
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
 * 速度跟着布局推进走，再用 o 与设定值的偏差校正，o 不出 [0, tail]。o 落到 0 而布局还在推进时保留速度 —— 下一个字马上就来，归零再起步就是一顿一顿。
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
