export const MINIMAP_TICK_PITCH = 8
export const MINIMAP_TICK_LINE_HEIGHT = 2
export const MINIMAP_SCROLL_PADDING = 8
export const MINIMAP_RESTING_WIDTH = 10
export const MINIMAP_ACTIVE_OVERHANG = 4
export const MINIMAP_TRACK_WIDTH = 40

const PEAK_WIDTH = 36
const NEIGHBOUR_WIDTH = 14
const RADIUS = 4
const SIGMA = 1.8
const bell = Array.from({ length: RADIUS + 1 }, (_, distance) =>
  Math.exp(-(distance * distance) / (2 * SIGMA * SIGMA)),
)

export function minimapTickWidth(index: number, pointerIndex: number): number {
  const distance = Math.abs(index - pointerIndex)

  if (pointerIndex < 0 || distance > RADIUS) {
    return MINIMAP_RESTING_WIDTH
  }

  const target = distance === 0 ? PEAK_WIDTH : NEIGHBOUR_WIDTH
  const influence = bell[distance] ?? 0

  return MINIMAP_RESTING_WIDTH + (target - MINIMAP_RESTING_WIDTH) * influence
}

export function minimapTickTop(index: number): number {
  return index * MINIMAP_TICK_PITCH + (MINIMAP_TICK_PITCH - MINIMAP_TICK_LINE_HEIGHT) / 2
}
