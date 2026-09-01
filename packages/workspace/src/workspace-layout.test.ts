import { describe, expect, it } from 'bun:test'
import { resolvePanelMode, WORKSPACE_LAYOUT } from './workspace-layout'

describe('WORKSPACE_LAYOUT', () => {
  it('keeps a rail panel from shrinking the main reading area', () => {
    expect(resolvePanelMode(1060, 420)).toBe('dock')
    expect(resolvePanelMode(1059, 420)).toBe('overlay')
    expect(resolvePanelMode(960, WORKSPACE_LAYOUT.todo.width)).toBe('dock')
    expect(resolvePanelMode(959, WORKSPACE_LAYOUT.todo.width)).toBe('overlay')
  })

  it('keeps the default sidebar width inside its bounds', () => {
    const { minWidth, defaultWidth, maxWidth } = WORKSPACE_LAYOUT.sidebar

    expect(minWidth).toBeLessThan(defaultWidth)

    expect(defaultWidth).toBeLessThan(maxWidth)
  })

  it('keeps the todo rail inside the auxiliary width range', () => {
    const { todo, auxiliary } = WORKSPACE_LAYOUT

    expect(todo.width).toBeGreaterThan(0)

    expect(todo.width).toBeLessThanOrEqual(auxiliary.maxWidth)
  })

  it('keeps the default auxiliary width inside its bounds', () => {
    const { minWidth, defaultWidth, maxWidth } = WORKSPACE_LAYOUT.auxiliary

    expect(minWidth).toBeLessThan(defaultWidth)

    expect(defaultWidth).toBeLessThan(maxWidth)
  })

  it('uses a short layout animation', () => {
    const duration = WORKSPACE_LAYOUT.motion.layoutDurationSeconds

    expect(Number.isFinite(duration)).toBe(true)

    expect(duration).toBeGreaterThan(0)

    /*
     * Layout animation should remain responsive.
     * Longer sequences belong to feature animation,
     * not shell geometry transitions.
     */
    expect(duration).toBeLessThanOrEqual(0.5)
  })

  it('uses a valid cubic-bezier tuple', () => {
    const ease = WORKSPACE_LAYOUT.motion.layoutEase

    expect(ease).toHaveLength(4)

    for (const controlPoint of ease) {
      expect(Number.isFinite(controlPoint)).toBe(true)
    }

    const [firstX, , secondX] = ease

    /*
     * CSS requires the X control points to remain
     * in the 0..1 range.
     */
    expect(firstX).toBeGreaterThanOrEqual(0)

    expect(firstX).toBeLessThanOrEqual(1)

    expect(secondX).toBeGreaterThanOrEqual(0)

    expect(secondX).toBeLessThanOrEqual(1)
  })
})
