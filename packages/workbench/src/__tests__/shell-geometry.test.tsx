import { afterEach, describe, expect, test } from 'bun:test'
import type { RpcMessage, WindowBridge } from '@poietica/rpc'
import { builtinPoints, createUiKernel, defineUiFeature, KernelProvider, type UiKernel } from '@poietica/ui-kernel'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { Workbench } from '../workbench'

/*
 * 三列宽度的端到端契约（真实故障：侧栏、右栏都拉满 → 收起侧栏，右栏还能再往左拉 → 再展开侧栏，主区明显变窄，
 * 一拖右栏又「跳」回去）。happy-dom 不做布局，所以这里量的是外壳写出去的那几份数：栅格列宽（内联自定义属性）、
 * 分隔条的 aria-valuemin / max / now。三条不变量：
 *   1. 画出来的列宽就是分隔条的当前值，且落在它自己的 [min, max] 里 —— 否则第一下拖拽就跳；
 *   2. 两侧列之和不超过「外壳宽 − 主列地板」—— 否则主区被挤窄；
 *   3. 同一份意图、同一个窗口宽，画出来的样子与操作历史无关（开合来回一遍回到原样）。
 */

const MAIN_FLOOR = 360

function testBridge(): WindowBridge {
  const listeners = new Set<(m: RpcMessage) => void>()
  return {
    send(message: RpcMessage) {
      if ('id' in message && typeof message.id === 'number' && 'method' in message) {
        const id = message.id
        queueMicrotask(() => {
          for (const l of [...listeners]) {
            l({ jsonrpc: '2.0', id, result: { state: 'starting', reason: null, attempt: 0 } })
          }
        })
      }
    },
    onMessage(listener: (message: RpcMessage) => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    pathForFile: () => 'C:/tmp/x',
  }
}

const panels = defineUiFeature({
  id: 'panels',
  setup: (ctx) => {
    ctx.contribute(builtinPoints.panels, {
      id: 'panels.review',
      location: 'right',
      order: 10,
      title: '审查',
      icon: () => <span />,
      component: () => <p>审查</p>,
    })
  },
})

afterEach(() => {
  cleanup()
  document.body.innerHTML = ''
})

async function mount(viewport: number): Promise<UiKernel> {
  const kernel = createUiKernel({
    features: [panels],
    errorMessages: {},
    validateResults: false,
    defaultRoute: { surface: 'home', params: {} },
    bridge: testBridge(),
  })
  await kernel.start()
  render(
    <KernelProvider kernel={kernel}>
      <Workbench />
    </KernelProvider>,
  )
  const { layout } = kernel.kernelServices
  act(() => {
    layout.setViewportWidth(viewport)
    layout.setActiveOwner('t1')
    layout.openPane('t1', 'panels.review')
  })
  return kernel
}

interface Region {
  readonly column: number
  readonly now: number
  readonly min: number
  readonly max: number
}

function splitter(label: string): HTMLElement {
  const el = document.querySelector<HTMLElement>(`hr[aria-label="${label}"]`)
  if (el === null) throw new Error(`没有「${label}」分隔条`)
  return el
}

/* 栅格列宽由 WorkspaceFrame 写成外壳根上的内联自定义属性。 */
function column(columnVar: string): number {
  const shell = document.querySelector<HTMLElement>('.workspace-shell')
  if (shell === null) throw new Error('外壳没挂上')
  return Number.parseFloat(shell.style.getPropertyValue(columnVar))
}

function region(label: string, columnVar: string): Region {
  const el = splitter(label)
  return {
    column: column(columnVar),
    now: Number(el.getAttribute('aria-valuenow')),
    min: Number(el.getAttribute('aria-valuemin')),
    max: Number(el.getAttribute('aria-valuemax')),
  }
}

const sidebar = (): Region => region('调整侧边栏宽度', '--workspace-sidebar-column-width')
const auxiliary = (): Region => region('调整辅助面板宽度', '--workspace-auxiliary-column-width')
const sidebarColumn = (): number => column('--workspace-sidebar-column-width')

/* 键盘 End = 把分隔条拖到它此刻的上限，与一路拖到头等价。 */
function dragToMax(label: string): void {
  act(() => {
    fireEvent.keyDown(splitter(label), { key: 'End' })
  })
}

function expectConsistent(r: Region, name: string): void {
  expect(r.now, `${name}：画出来的列宽就是分隔条的当前值`).toBe(r.column)
  expect(r.column, `${name}：列宽不低于下限`).toBeGreaterThanOrEqual(r.min)
  expect(r.column, `${name}：列宽不超过分隔条上限（否则一拖就跳）`).toBeLessThanOrEqual(r.max)
}

describe('外壳三列的宽度几何', () => {
  test('用户复现：两侧拉满 → 收起侧栏 → 右栏再拉满 → 展开侧栏：不挤主区、不跳', async () => {
    const kernel = await mount(1950)
    dragToMax('调整侧边栏宽度')
    dragToMax('调整辅助面板宽度')
    const before = auxiliary()
    expectConsistent(sidebar(), '侧栏')
    expectConsistent(before, '右栏')

    act(() => kernel.kernelServices.layout.toggleSidebar())
    dragToMax('调整辅助面板宽度')

    act(() => kernel.kernelServices.layout.toggleSidebar())
    const after = auxiliary()
    expectConsistent(after, '右栏（侧栏重新展开后）')
    expect(after.column, '开合来回一遍回到原样').toBe(before.column)
    expect(1950 - sidebar().column - after.column).toBeGreaterThanOrEqual(MAIN_FLOOR)
    kernel.dispose()
  })

  /* 上限只看产品常量与「窗口剩多少」，不看另一侧开没开：否则「最大」本身随开合漂移，开合来回一遍就回不到原样。 */
  test('收起侧栏不抬高右栏的产品上限', async () => {
    const kernel = await mount(1950)
    const docked = auxiliary().max
    act(() => kernel.kernelServices.layout.toggleSidebar())
    expect(auxiliary().max).toBe(docked)
    kernel.dispose()
  })

  test('默认窗口 1280：侧栏、右栏都拉满，主区仍保住地板', async () => {
    const kernel = await mount(1280)
    dragToMax('调整侧边栏宽度')
    dragToMax('调整辅助面板宽度')
    expectConsistent(sidebar(), '侧栏')
    expectConsistent(auxiliary(), '右栏')
    expect(1280 - sidebar().column - auxiliary().column).toBeGreaterThanOrEqual(MAIN_FLOOR)
    kernel.dispose()
  })

  test('窗口变窄：右栏先让位；变回原宽：右栏回到拖出来的宽度（意图不丢）', async () => {
    const kernel = await mount(1600)
    dragToMax('调整辅助面板宽度')
    const wide = auxiliary().column

    act(() => kernel.kernelServices.layout.setViewportWidth(1100))
    expectConsistent(auxiliary(), '右栏（窗口变窄）')
    expect(1100 - sidebar().column - auxiliary().column).toBeGreaterThanOrEqual(MAIN_FLOOR)

    act(() => kernel.kernelServices.layout.setViewportWidth(1600))
    expect(auxiliary().column).toBe(wide)
    kernel.dispose()
  })

  test('拖宽侧栏也不挤主区：主区到地板时侧栏推右栏，右栏最多推到下限', async () => {
    const kernel = await mount(1100)
    dragToMax('调整侧边栏宽度')
    expectConsistent(sidebar(), '侧栏')
    expectConsistent(auxiliary(), '右栏')
    expect(1100 - sidebar().column - auxiliary().column).toBeGreaterThanOrEqual(MAIN_FLOOR)
    kernel.dispose()
  })

  test('读盘读到超出产品上限的宽度：画出来的仍在分隔条范围内', async () => {
    const kernel = await mount(1950)
    act(() =>
      kernel.kernelServices.layout.restore({
        sidebar: { visible: true, width: 480 },
        right: { size: 900 },
        auxiliary: { owner: 't1' },
      }),
    )
    act(() => kernel.kernelServices.layout.setActiveOwner('t1'))
    expectConsistent(sidebar(), '侧栏')
    expectConsistent(auxiliary(), '右栏')
    kernel.dispose()
  })

  test('还没量到外壳宽（0 是未布局时的读数）：不按 0 宽去压两侧', async () => {
    const kernel = await mount(1950)
    const before = sidebarColumn()
    act(() => kernel.kernelServices.layout.setViewportWidth(0))
    expect(sidebarColumn()).toBe(before)
    kernel.dispose()
  })
})
