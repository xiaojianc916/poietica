/* 曲线与 skin/metrics.css 的 --cp-motion-drawer-ease 必须同一条：CSS 令牌读不进 JS，这里是 JS 侧唯一产地。 */

export const ENTER_EASE: [number, number, number, number] = [0.2, 0, 0, 1]
export const EXIT_EASE: [number, number, number, number] = [0.4, 0, 1, 1]

export const ENTER_SECONDS = 0.2
export const EXIT_SECONDS = 0.14

/** 浮层起落的位移，与 --cp-motion-rise 同值。 */
export const RISE_PX = 4
