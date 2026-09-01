import { describe, expect, it } from 'bun:test'
import { resolvePanelMode, WORKSPACE_LAYOUT } from './workspace-layout'

describe('WORKSPACE_LAYOUT', () => {
  it('overlays a panel before it can shrink the main reading area', () => {
    expect(resolvePanelMode(1060, 420)).toBe('dock')
    expect(resolvePanelMode(1059, 420)).toBe('overlay')

    const todoReserve = WORKSPACE_LAYOUT.todo.width + WORKSPACE_LAYOUT.todo.gap * 2
    expect(resolvePanelMode(WORKSPACE_LAYOUT.main.minWidth + todoReserve, todoReserve)).toBe('dock')
    expect(resolvePanelMode(WORKSPACE_LAYOUT.main.minWidth + todoReserve - 1, todoReserve)).toBe(
      'overlay',
    )
  })

  it('keeps the default sidebar width inside its bounds', () => {
    const { minWidth, defaultWidth, maxWidth } = WORKSPACE_LAYOUT.sidebar
    expect(minWidth).toBeLessThan(defaultWidth)
    expect(defaultWidth).toBeLessThan(maxWidth)
  })

  it('keeps the todo popup inside the auxiliary width range', () => {
    const { todo, auxiliary } = WORKSPACE_LAYOUT
    expect(todo.width).toBeGreaterThan(0)
    expect(todo.gap).toBeGreaterThan(0)
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
    expect(duration).toBeLessThanOrEqual(0.5)
  })

  it('uses a valid cubic-bezier tuple', () => {
    const ease = WORKSPACE_LAYOUT.motion.layoutEase
    expect(ease).toHaveLength(4)
    for (const controlPoint of ease) {
      expect(Number.isFinite(controlPoint)).toBe(true)
    }
    const [firstX, , secondX] = ease
    expect(firstX).toBeGreaterThanOrEqual(0)
    expect(firstX).toBeLessThanOrEqual(1)
    expect(secondX).toBeGreaterThanOrEqual(0)
    expect(secondX).toBeLessThanOrEqual(1)
  })
})
