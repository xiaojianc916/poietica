import { describe, expect, it } from 'bun:test'
import {
  RAIL_PITCH_PX,
  RAIL_REACH_PX,
  railCentre,
  railWeight,
  railWindow,
} from '../minimap/conversation-minimap-geometry'

describe('conversation minimap geometry', () => {
  it('peaks under the pointer and falls off symmetrically', () => {
    expect(railWeight(0)).toBe(1)
    expect(railWeight(-RAIL_PITCH_PX)).toBe(railWeight(RAIL_PITCH_PX))
    expect(railWeight(RAIL_PITCH_PX)).toBeGreaterThan(railWeight(RAIL_PITCH_PX * 2))
    expect(railWeight(RAIL_REACH_PX)).toBeLessThan(0.002)
  })
  it('spaces centres one pitch apart', () => {
    expect(railCentre(7) - railCentre(6)).toBe(RAIL_PITCH_PX)
  })
  it('covers exactly the bars within reach', () => {
    const anchor = railCentre(20)
    const span = railWindow(anchor, 100)
    expect(railCentre(span.from)).toBeGreaterThanOrEqual(anchor - RAIL_REACH_PX)
    expect(railCentre(span.to)).toBeLessThanOrEqual(anchor + RAIL_REACH_PX)
    expect(railCentre(span.from - 1)).toBeLessThan(anchor - RAIL_REACH_PX)
    expect(railCentre(span.to + 1)).toBeGreaterThan(anchor + RAIL_REACH_PX)
  })
  it('clamps the neighbourhood to the rail', () => {
    expect(railWindow(railCentre(0), 4).from).toBe(0)
    expect(railWindow(railCentre(3), 4).to).toBe(3)
  })
})
