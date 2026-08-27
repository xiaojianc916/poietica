import { describe, expect, it } from 'bun:test'

import {
  MINIMAP_RESTING_WIDTH,
  MINIMAP_TICK_LINE_HEIGHT,
  MINIMAP_TICK_PITCH,
  minimapTickTop,
  minimapTickWidth,
} from '../minimap/conversation-minimap-geometry'

describe('conversation minimap geometry', () => {
  it('makes the pointed tick the widest and falls off symmetrically', () => {
    const widths = Array.from({ length: 11 }, (_, index) => minimapTickWidth(index, 5))

    expect(widths[5]).toBeGreaterThan(widths[4] ?? 0)
    expect(widths[4]).toBe(widths[6])
    expect(widths[3]).toBe(widths[7])
    expect(widths[0]).toBe(MINIMAP_RESTING_WIDTH)
    expect(widths[10]).toBe(MINIMAP_RESTING_WIDTH)
  })

  it('uses one pitch source for ticks and the active marker', () => {
    expect(minimapTickTop(0)).toBe((MINIMAP_TICK_PITCH - MINIMAP_TICK_LINE_HEIGHT) / 2)
    expect(minimapTickTop(7) - minimapTickTop(6)).toBe(MINIMAP_TICK_PITCH)
  })
})
