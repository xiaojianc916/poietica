/*
 * 这一面的动效词汇：进场减速，退场加速且更短 —— 退场是一个已经做完的决定。
 *
 * 曲线与 @poietica/composer 的 composer-metrics.css 的 --cp-motion-drawer-ease 同一条：
 * motion 要的是数，而 CSS 令牌读不进 JS，所以这里是它在 JS 侧的唯一产地。
 */

export const ENTER_EASE: [number, number, number, number] = [0.2, 0, 0, 1]
export const EXIT_EASE: [number, number, number, number] = [0.4, 0, 1, 1]

export const ENTER_SECONDS = 0.2
export const EXIT_SECONDS = 0.14

/** 浮层起落的位移，与 --cp-motion-rise 同值。 */
export const RISE_PX = 4

/** 拖动落位：跟手，不过冲。 */
export const DRAG_SPRING = { damping: 38, mass: 0.6, stiffness: 520, type: 'spring' } as const
