import { describe, expect, test } from 'bun:test'
import {
  createLayoutService,
  DEFAULT_LAYOUT,
  LAYOUT_LIMITS,
  type LayoutGeometry,
  type LayoutService,
  resolveLayoutGeometry,
} from '../services/layout'

/*
 * 有效几何的不变量。外壳那边（workbench 的 shell-geometry.test.tsx）钉的是「写出去的数」，这里钉解算本身：
 * 随机操作序列里每一步都必须成立，任何一条写入路径（开合、拖拽、窗口改宽、读盘）漏了重算都会在这里红。
 */

const [S_MIN, S_MAX] = LAYOUT_LIMITS.sidebar
const [R_MIN, R_MAX] = LAYOUT_LIMITS.right
const FLOOR = LAYOUT_LIMITS.mainMin

/* 固定种子的 LCG：失败可复现，不引第三方。 */
function rng(seed: number): () => number {
  let x = seed >>> 0
  return () => {
    x = (Math.imul(x, 1_664_525) + 1_013_904_223) >>> 0
    return x / 0x1_0000_0000
  }
}

function openDock(l: LayoutService): void {
  l.setActiveOwner('t1')
  l.openPane('t1', 'p1')
}

function checkInvariants(g: LayoutGeometry, l: LayoutService, step: string): void {
  const state = l.current()
  const viewport = l.viewportWidth()
  for (const [name, r, docked] of [
    ['侧栏', g.sidebar, state.sidebar.visible],
    ['右栏', g.right, state.right.open],
  ] as const) {
    expect(r.min, `${step} ${name} min ≤ max`).toBeLessThanOrEqual(r.max)
    expect(r.size, `${step} ${name} size ≥ min`).toBeGreaterThanOrEqual(r.min)
    expect(r.size, `${step} ${name} size ≤ max`).toBeLessThanOrEqual(r.max)
    expect(r.column, `${step} ${name} column`).toBe(docked ? r.size : 0)
  }
  expect(g.sidebar.max, `${step} 侧栏上限不超产品上限`).toBeLessThanOrEqual(S_MAX)
  expect(g.right.max, `${step} 右栏上限不超产品上限`).toBeLessThanOrEqual(R_MAX)
  if (viewport === null) return
  const mins = (state.sidebar.visible ? S_MIN : 0) + (state.right.open ? R_MIN : 0)
  const sides = g.sidebar.column + g.right.column
  if (viewport - FLOOR >= mins) {
    expect(sides, `${step} 放得下时主列保住地板`).toBeLessThanOrEqual(viewport - FLOOR)
  } else {
    /* 放不下时两侧都在下限，差额只由主列吃。 */
    expect(sides, `${step} 放不下时两侧都在下限`).toBe(mins)
  }
}

describe('resolveLayoutGeometry', () => {
  test('还没量到外壳：只按产品边界钳，不设窗口这一维', () => {
    const g = resolveLayoutGeometry(
      { ...DEFAULT_LAYOUT, sidebar: { visible: true, width: 9999 }, right: { open: true, activeId: 'p', size: 9999 } },
      null,
    )
    expect(g.sidebar).toEqual({ size: S_MAX, column: S_MAX, min: S_MIN, max: S_MAX })
    expect(g.right).toEqual({ size: R_MAX, column: R_MAX, min: R_MIN, max: R_MAX })
  })

  test('右栏上限与侧栏开没开无关（宽窗口）', () => {
    const open = { ...DEFAULT_LAYOUT, right: { open: true, activeId: 'p', size: 9999 } }
    const docked = resolveLayoutGeometry(open, 1950)
    const collapsed = resolveLayoutGeometry({ ...open, sidebar: { visible: false, width: S_MAX } }, 1950)
    expect(collapsed.right.max).toBe(docked.right.max)
    expect(collapsed.right.size).toBe(docked.right.size)
  })

  test('让位次序：右栏先缩到下限，侧栏再缩', () => {
    const state = {
      ...DEFAULT_LAYOUT,
      sidebar: { visible: true, width: S_MAX },
      right: { open: true, activeId: 'p', size: R_MAX },
    }
    /* 两侧合计只有 1000 − 360 = 640：右栏先缩到下限 320，剩下的 320 给侧栏（意图 360 也得让）。 */
    const g = resolveLayoutGeometry(state, 1000)
    expect(g.right.size).toBe(R_MIN)
    expect(g.sidebar.size).toBe(1000 - FLOOR - R_MIN)
    /* 再宽一点：侧栏回到意图，右栏拿剩下的。 */
    const h = resolveLayoutGeometry(state, 1200)
    expect(h.sidebar.size).toBe(S_MAX)
    expect(h.right.size).toBe(1200 - FLOOR - S_MAX)
  })
})

describe('LayoutService.geometry', () => {
  test('窗口宽变化即重算并通知；同值与非正读数不通知', () => {
    const l = createLayoutService()
    let calls = 0
    l.geometry.subscribe(() => {
      calls += 1
    })
    l.setViewportWidth(1280)
    /* 默认布局在 1280 下列宽不变，但右栏上限从 800 收到 1280 − 360 − 280 = 640：上限也是几何的一部分。 */
    expect(calls).toBe(1)
    expect(l.geometry.current().right.max).toBe(1280 - FLOOR - DEFAULT_LAYOUT.sidebar.width)
    openDock(l)
    const before = calls
    l.setPanelSize('right', R_MAX)
    expect(calls).toBeGreaterThan(before)
    expect(l.geometry.current().right.size).toBe(1280 - FLOOR - DEFAULT_LAYOUT.sidebar.width)
    const settled = calls
    l.setViewportWidth(1280)
    l.setViewportWidth(0)
    l.setViewportWidth(Number.NaN)
    expect(calls).toBe(settled)
    expect(l.viewportWidth()).toBe(1280)
  })

  test('意图不随让位改写：窗口缩了又放回，宽度原样回来', () => {
    const l = createLayoutService()
    l.setViewportWidth(1950)
    openDock(l)
    l.setPanelSize('right', 700)
    l.setViewportWidth(1000)
    expect(l.current().right.size).toBe(700)
    expect(l.geometry.current().right.size).toBeLessThan(700)
    l.setViewportWidth(1950)
    expect(l.geometry.current().right.size).toBe(700)
  })

  test('随机操作序列：每一步都满足不变量；开合来回一遍回到原样', () => {
    const next = rng(20_261_019)
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)] as T
    const l = createLayoutService()
    openDock(l)
    for (let i = 0; i < 2_000; i += 1) {
      const op = pick(['viewport', 'sidebarWidth', 'rightSize', 'toggleSidebar', 'toggleRight', 'dragMax'] as const)
      switch (op) {
        case 'viewport':
          l.setViewportWidth(600 + Math.floor(next() * 1800))
          break
        case 'sidebarWidth':
          l.setSidebarWidth(100 + next() * 600)
          break
        case 'rightSize':
          l.setPanelSize('right', 100 + next() * 1200)
          break
        case 'toggleSidebar': {
          const g = l.geometry.current()
          l.toggleSidebar()
          l.toggleSidebar()
          expect(l.geometry.current(), `#${i} 侧栏开合来回`).toEqual(g)
          break
        }
        case 'toggleRight':
          l.togglePanel('right')
          break
        case 'dragMax': {
          /* 拖到头 = 分隔条按此刻上限写回；写回之后它必须仍是上限（上限不随自己的写入后退）。 */
          const region = pick(['sidebar', 'right'] as const)
          const max = l.geometry.current()[region].max
          if (region === 'sidebar') l.setSidebarWidth(max)
          else l.setPanelSize('right', max)
          expect(l.geometry.current()[region].size, `#${i} 拖到头后停在上限`).toBe(max)
          break
        }
      }
      checkInvariants(l.geometry.current(), l, `#${i} ${op}`)
    }
  })
})
