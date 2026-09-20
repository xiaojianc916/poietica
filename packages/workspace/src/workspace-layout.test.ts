import { describe, expect, it } from 'bun:test'
import { auxiliaryMaxWidth, WORKSPACE_LAYOUT } from './workspace-layout'

describe('WORKSPACE_LAYOUT', () => {
  it('keeps the default sidebar width inside its bounds', () => {
    const { minWidth, defaultWidth, maxWidth } = WORKSPACE_LAYOUT.sidebar
    expect(minWidth).toBeLessThan(defaultWidth)
    expect(defaultWidth).toBeLessThan(maxWidth)
  })

  it('keeps the todo popup geometry positive', () => {
    const { todo } = WORKSPACE_LAYOUT
    expect(todo.width).toBeGreaterThan(0)
    expect(todo.gap).toBeGreaterThan(0)
  })

  it('keeps the default auxiliary width inside its bounds', () => {
    const { minWidth, defaultWidth, maxWidth } = WORKSPACE_LAYOUT.auxiliary
    expect(minWidth).toBeLessThan(defaultWidth)
    expect(defaultWidth).toBeLessThan(maxWidth)
  })

  it('widens the auxiliary cap by the width the sidebar gives up when it closes', () => {
    const { auxiliary, sidebar } = WORKSPACE_LAYOUT
    const sidebarWidth = sidebar.defaultWidth
    const open = { sidebarOpen: true, sidebarWidth }
    const closed = { sidebarOpen: false, sidebarWidth }
    expect(auxiliaryMaxWidth(open)).toBe(auxiliary.maxWidth)
    expect(auxiliaryMaxWidth(closed)).toBe(auxiliary.maxWidth + sidebarWidth)
    expect(auxiliaryMaxWidth({ ...open, sidebarWidth: 0 })).toBe(auxiliary.maxWidth)
  })

  it('never lets the auxiliary pane push the main column out of the shell', () => {
    const { auxiliary, main, sidebar } = WORKSPACE_LAYOUT
    const sidebarWidth = sidebar.defaultWidth

    /* 中间地带：上限正好是「窗口 − 侧栏 − 主列地板」。 */
    const viewportWidth = 1000
    expect(auxiliaryMaxWidth({ sidebarOpen: true, sidebarWidth, viewportWidth })).toBe(
      viewportWidth - sidebarWidth - main.minWidth,
    )

    /* 窗口够宽时产品上限说了算，窗口那一维不介入。 */
    expect(auxiliaryMaxWidth({ sidebarOpen: true, sidebarWidth, viewportWidth: 1600 })).toBe(
      auxiliary.maxWidth,
    )

    /* 窗口窄到连下限都放不下时下限优先：主列是 minmax(0, 1fr)，该让的是它，
     * 而且上限低过下限会让分隔条的 aria-valuemax 小于 aria-valuemin。 */
    const narrow = auxiliaryMaxWidth({ sidebarOpen: true, sidebarWidth, viewportWidth: 800 })
    expect(narrow).toBe(auxiliary.minWidth)
    expect(narrow).toBeLessThanOrEqual(auxiliary.maxWidth)
  })

  it('does not constrain the auxiliary pane before the shell has been measured', () => {
    const { auxiliary, sidebar } = WORKSPACE_LAYOUT
    const layout = { sidebarOpen: true, sidebarWidth: sidebar.defaultWidth }
    expect(auxiliaryMaxWidth({ ...layout, viewportWidth: null })).toBe(auxiliary.maxWidth)
    expect(auxiliaryMaxWidth(layout)).toBe(auxiliary.maxWidth)
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
