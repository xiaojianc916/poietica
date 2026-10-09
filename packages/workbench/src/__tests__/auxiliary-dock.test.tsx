import { afterEach, describe, expect, test } from 'bun:test'
import type { RpcMessage, WindowBridge } from '@poietica/rpc'
import { builtinPoints, createUiKernel, defineUiFeature, KernelProvider, type UiFeature } from '@poietica/ui-kernel'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { Workbench } from '../workbench'

/*
 * 右坞与主区右上角控件（legacy 的 auxiliary dock + main.controls）。
 *
 * 这一段是用户 2026-10-07 的两条报障：进入对话后右上角没有开关；右栏的样子与逻辑
 * 跟 legacy 不是一回事。用例钉住的是形状与语义：
 *   - mainControls 贡献按 order 落进栅格，data-slot 分主区 / 窗口两格；
 *   - 右坞空态画启动器（offer !== false 的面板），点一枚开一格；
 *   - 开了之后标签条取代启动器，点 × 关掉回到启动器；
 *   - 全屏按钮改的是 auxiliary.fullscreen，外壳跟着把 data-auxiliary-fullscreen 翻过去；
 *   - 坞只画当前归属（auxiliary.owner === activeOwner）的格。
 */

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

async function mount(features: readonly UiFeature[] = []) {
  const kernel = createUiKernel({
    features,
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
  return kernel
}

/** 三枚 offer 面板（辅助对话 / 审查 / 终端）+ 一枚 offer:false 的（技能文档）。 */
function panelsFeature(): UiFeature {
  return defineUiFeature({
    id: 'panels',
    setup: (ctx) => {
      for (const [id, title, order] of [
        ['panels.assistant', '辅助对话', 5],
        ['panels.review', '审查', 10],
        ['panels.terminal', '终端', 15],
      ] as const) {
        ctx.contribute(builtinPoints.panels, {
          id,
          location: 'right',
          order,
          title,
          icon: () => <span />,
          component: () => <p data-panel={id}>{title}的正文</p>,
        })
      }
      ctx.contribute(builtinPoints.panels, {
        id: 'panels.skill',
        location: 'right',
        order: 30,
        title: '技能文档',
        icon: () => <span />,
        offer: false,
        component: () => <p data-panel="panels.skill">技能文档的正文</p>,
      })
    },
  })
}

afterEach(() => {
  cleanup()
  document.body.innerHTML = ''
})

describe('主区右上角控件（mainControls）', () => {
  test('按 order 落进栅格，data-slot 分「主区」与「窗口」两格', async () => {
    const feature = defineUiFeature({
      id: 'controls',
      setup: (ctx) => {
        ctx.contribute(builtinPoints.mainControls, {
          id: 'controls.auxiliary',
          order: 20,
          slot: 'window',
          component: () => <button data-ctl="auxiliary" type="button" />,
        })
        ctx.contribute(builtinPoints.mainControls, {
          id: 'controls.todo',
          order: 10,
          slot: 'main',
          component: () => <button data-ctl="todo" type="button" />,
        })
      },
    })
    const kernel = await mount([feature])

    const nodes = [...document.querySelectorAll('.workspace-shell__conversation-control')]
    expect(nodes.map((el) => el.getAttribute('data-slot'))).toEqual(['main', 'window'])
    expect(nodes[0]?.querySelector('[data-ctl="todo"]')).not.toBeNull()
    expect(nodes[1]?.querySelector('[data-ctl="auxiliary"]')).not.toBeNull()
    kernel.dispose()
  })

  test('没有贡献时这一格是空的：外壳不为它画占位', async () => {
    const kernel = await mount()
    expect(document.querySelector('.workspace-shell__conversation-control')).toBeNull()
    kernel.dispose()
  })
})

describe('右坞（启动器 / 标签条 / 全屏）', () => {
  test('空态画启动器：offer !== false 的三枚按 order，offer:false 的不出现', async () => {
    const kernel = await mount([panelsFeature()])

    const launcher = document.querySelector('section[aria-label="辅助面板启动器"]')
    expect(launcher).not.toBeNull()

    const labels = [...launcher!.querySelectorAll('button')].map((b) => b.textContent)
    expect(labels).toEqual(['辅助对话', '审查', '终端'])
    kernel.dispose()
  })

  /*
   * 走到启动器的真实路径：对话框那一枚辅助开关先把坞认领给这条对话（owner = threadId,
   * activeOwner 由表面声明），坞开出来、里面一格都没有 —— 这时看到的就是启动器。
   */
  test('点启动器一枚：开一格，标签条取代启动器', async () => {
    const kernel = await mount([panelsFeature()])
    const { layout } = kernel.kernelServices

    layout.setActiveOwner('t1')
    layout.setAuxiliaryOwner('t1')
    await new Promise((r) => setTimeout(r, 5))

    const review = [...document.querySelectorAll('section[aria-label="辅助面板启动器"] button')].find((b) =>
      (b.textContent ?? '').includes('审查'),
    )
    fireEvent.click(review!)
    await new Promise((r) => setTimeout(r, 5))

    expect(document.querySelector('section[aria-label="辅助面板启动器"]')).toBeNull()
    const tabs = [...document.querySelectorAll('[role="tab"]')]
    expect(tabs).toHaveLength(1)
    expect(tabs[0]?.textContent).toContain('审查')
    expect(tabs[0]?.getAttribute('aria-selected')).toBe('true')
    expect(document.querySelector('[data-panel="panels.review"]')).not.toBeNull()
    kernel.dispose()
  })

  test('加号菜单能再开一格，两格都在；点 × 关掉一格', async () => {
    const kernel = await mount([panelsFeature()])
    const { layout } = kernel.kernelServices

    layout.setActiveOwner('t1')
    layout.openPane('t1', 'panels.review')
    await new Promise((r) => setTimeout(r, 5))

    layout.openPane('t1', 'panels.terminal')
    await new Promise((r) => setTimeout(r, 5))

    const tabs = () => [...document.querySelectorAll('[role="tab"]')]
    expect(tabs().map((t) => t.textContent)).toEqual(['审查', '终端'])

    const close = tabs()[0]?.querySelector('[data-close-tab]')
    expect(close).not.toBeNull()
    fireEvent.click(close!)
    await new Promise((r) => setTimeout(r, 5))

    expect(tabs().map((t) => t.textContent)).toEqual(['终端'])
    kernel.dispose()
  })

  test('关掉最后一格回到启动器', async () => {
    const kernel = await mount([panelsFeature()])
    const { layout } = kernel.kernelServices

    layout.setActiveOwner('t1')
    layout.openPane('t1', 'panels.review')
    await new Promise((r) => setTimeout(r, 5))
    layout.closePane('t1', 'panels.review')
    await new Promise((r) => setTimeout(r, 5))

    expect(document.querySelector('section[aria-label="辅助面板启动器"]')).not.toBeNull()
    kernel.dispose()
  })

  test('全屏按钮：翻 auxiliary.fullscreen，外壳把 data-auxiliary-fullscreen 一起翻', async () => {
    const kernel = await mount([panelsFeature()])
    const { layout } = kernel.kernelServices

    layout.setActiveOwner('t1')
    layout.openPane('t1', 'panels.review')
    await new Promise((r) => setTimeout(r, 5))

    const shell = () => document.querySelector('.workspace-shell')
    expect(shell()?.getAttribute('data-auxiliary-fullscreen')).toBe('false')

    fireEvent.click(document.querySelector('button[aria-label="全屏显示"]')!)
    await new Promise((r) => setTimeout(r, 5))

    expect(layout.current().auxiliary.fullscreen).toBe(true)
    expect(shell()?.getAttribute('data-auxiliary-fullscreen')).toBe('true')
    expect(document.querySelector('button[aria-label="退出全屏显示"]')).not.toBeNull()
    kernel.dispose()
  })

  /*
   * 归属语义（legacy auxiliaryThread === activeConversationId）：坞只画**当前前台**
   * 那一份格清单。换一条对话（activeOwner 变了）面板立刻离场，格还留着 —— 切回来
   * 原样还在，不会串门。
   */
  test('换前台归属：面板离场但格保留，切回原归属原样还在', async () => {
    const kernel = await mount([panelsFeature()])
    const { layout } = kernel.kernelServices

    layout.setActiveOwner('t1')
    layout.openPane('t1', 'panels.review')
    await new Promise((r) => setTimeout(r, 5))
    expect(document.querySelector('.workspace-shell')?.getAttribute('data-auxiliary-docked')).toBe('true')

    layout.setActiveOwner('t2')
    await new Promise((r) => setTimeout(r, 5))
    expect(document.querySelector('.workspace-shell')?.getAttribute('data-auxiliary-docked')).toBe('false')

    layout.setActiveOwner('t1')
    await new Promise((r) => setTimeout(r, 5))
    expect(document.querySelector('.workspace-shell')?.getAttribute('data-auxiliary-docked')).toBe('true')
    expect(document.querySelector('[role="tab"]')?.textContent).toContain('审查')
    kernel.dispose()
  })
})
