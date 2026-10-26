import { afterEach, describe, expect, test } from 'bun:test'
import type { RpcMessage, WindowBridge } from '@poietica/rpc'
import {
  builtinPoints,
  createUiKernel,
  defineUiFeature,
  KernelProvider,
  type PanelDockTabs,
  SETTINGS_GROUPS,
  settingsDockOwner,
  type UiFeature,
} from '@poietica/ui-kernel'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { workbenchFeature } from '../feature'
import { Workbench } from '../workbench'

/* 技能文档那一格只属于设置里的「技能」页。 */
const SKILLS_OWNER = settingsDockOwner('skills')

/*
 * 右坞与主区右上角控件。用例钉住的是形状与语义：mainControls 按 order 落进栅格（data-slot 分主区 / 窗口两格）；
 * 右坞空态画启动器、点一枚开一格、点 × 回到启动器；全屏翻 auxiliary.fullscreen；坞只画当前归属的格。
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
        scope: SKILLS_OWNER,
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
   * 走到启动器的真实路径：辅助开关先把坞认领给这条对话（owner = threadId），
   * 坞开出来但里面一格都没有 —— 这时看到的就是启动器。
   */
  test('点启动器一枚：开一格，标签条取代启动器', async () => {
    const kernel = await mount([panelsFeature()])
    const { layout } = kernel.kernelServices

    layout.setActiveOwner('t1')
    layout.setDockOpen('t1', true)
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
   * 坞只画**当前前台**那一份格清单。换一条对话（activeOwner 变了）面板立刻离场，
   * 格还留着 —— 切回来原样还在，不会串门。
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

describe('右坞按归属分账', () => {
  const docked = () => document.querySelector('.workspace-shell')?.getAttribute('data-auxiliary-docked')
  const settle = () => new Promise((r) => setTimeout(r, 5))

  /* 以前坞只有一个 owner 槽：在 t2 开坞会把 t1 的坞「认领」走，切回 t1 发现它被收起了。 */
  test('每条对话自己记开合：在 t2 开坞不会收掉 t1 的', async () => {
    const kernel = await mount([panelsFeature()])
    const { layout } = kernel.kernelServices

    layout.setActiveOwner('t1')
    layout.openPane('t1', 'panels.review')
    layout.setActiveOwner('t2')
    layout.openPane('t2', 'panels.terminal')
    await settle()
    expect(docked()).toBe('true')
    expect(document.querySelector('[role="tab"]')?.textContent).toContain('终端')

    layout.setActiveOwner('t1')
    await settle()
    expect(docked()).toBe('true')
    expect(document.querySelector('[role="tab"]')?.textContent).toContain('审查')
    kernel.dispose()
  })

  /* 用户要的形状：设置页（技能）的右坞只看技能文档本身，没有标签条，更没有别的面板。 */
  test('设置页的坞只画技能那一格：没有标签条、启动器与全屏，对话的面板开不进来', async () => {
    const kernel = await mount([panelsFeature()])
    const { layout } = kernel.kernelServices

    layout.setActiveOwner(SKILLS_OWNER)
    layout.openPanel('right', 'panels.review')
    layout.togglePanel('right')
    await settle()
    /* 一格都没开时开不出一块空白，也开不出对话的面板 */
    expect(docked()).toBe('false')

    layout.openPanel('right', 'panels.skill')
    await settle()
    expect(docked()).toBe('true')
    expect(document.querySelector('[data-panel="panels.skill"]')).not.toBeNull()
    expect(document.querySelector('[role="tablist"]')).toBeNull()
    expect(document.querySelector('section[aria-label="辅助面板启动器"]')).toBeNull()
    expect(document.querySelector('button[aria-label="全屏显示"]')).toBeNull()
    expect(layout.panes.current().byOwner[SKILLS_OWNER]?.ids).toEqual(['panels.skill'])
    kernel.dispose()
  })

  test('对话的坞里开不出设置页的格，启动器里也没有它', async () => {
    const kernel = await mount([panelsFeature()])
    const { layout } = kernel.kernelServices

    layout.setActiveOwner('t1')
    layout.openPanel('right', 'panels.skill')
    await settle()
    expect(docked()).toBe('false')

    layout.setDockOpen('t1', true)
    await settle()
    const labels = [...document.querySelectorAll('section[aria-label="辅助面板启动器"] button')].map(
      (b) => b.textContent,
    )
    expect(labels.some((label) => (label ?? '').includes('技能文档'))).toBe(false)
    kernel.dispose()
  })

  /* 前台只有一个写者：外壳按路由查表面的 dockOwner。没写 dockOwner 的表面（自动化、代码审查）不沿用上一页对话的坞。 */
  test('前台归属跟着路由走：有 dockOwner 的表面认领，没有的就是「没有归属」', async () => {
    const surfaces = defineUiFeature({
      id: 'surfaces',
      setup: (ctx) => {
        ctx.contribute(builtinPoints.surfaces, {
          id: 'surfaces.thread',
          title: '对话',
          dockOwner: (params) => params.threadId ?? null,
          component: () => <p>对话</p>,
        })
        ctx.contribute(builtinPoints.surfaces, {
          id: 'surfaces.plain',
          title: '别的页',
          component: () => <p>别的页</p>,
        })
      },
    })
    const kernel = await mount([panelsFeature(), surfaces])
    const { layout, navigation } = kernel.kernelServices

    navigation.navigate({ surface: 'surfaces.thread', params: { threadId: 't1' } })
    await settle()
    expect(layout.current().auxiliary.activeOwner).toBe('t1')
    layout.openPanel('right', 'panels.review')
    await settle()
    expect(docked()).toBe('true')

    navigation.navigate({ surface: 'surfaces.plain', params: {} })
    await settle()
    expect(layout.current().auxiliary.activeOwner).toBeNull()
    expect(docked()).toBe('false')

    navigation.navigate({ surface: 'surfaces.thread', params: { threadId: 't1' } })
    await settle()
    expect(docked()).toBe('true')
    kernel.dispose()
  })
})

/*
 * 用户 2026-10-20 报的故障：技能页开着技能文档，按「返回」退出设置，再打开设置（落在缺省的「通用」页），
 * 右坞照样开着、画的还是技能文档。走真路由：设置表面、设置页与 Workbench 的 dockOwner 解析都是真身。
 */
describe('设置的右坞按页分账', () => {
  const docked = () => document.querySelector('.workspace-shell')?.getAttribute('data-auxiliary-docked')
  const settle = () => new Promise((r) => setTimeout(r, 5))

  function settingsPagesFeature(): UiFeature {
    return defineUiFeature({
      id: 'pages',
      setup: (ctx) => {
        ctx.contribute(builtinPoints.settingsPages, {
          id: 'general',
          group: SETTINGS_GROUPS.app,
          order: 10,
          title: '通用',
          icon: () => <span />,
          component: () => <p>通用页</p>,
        })
        ctx.contribute(builtinPoints.settingsPages, {
          id: 'skills',
          group: SETTINGS_GROUPS.agent,
          order: 500,
          title: '技能',
          icon: () => <span />,
          component: () => <p>技能页</p>,
        })
      },
    })
  }

  test('技能页开的技能文档：退出设置再进来落在「通用」页时不在场，Ctrl+Alt+B 也打不开；回到技能页原样还在', async () => {
    const kernel = await mount([workbenchFeature, settingsPagesFeature(), panelsFeature()])
    const { layout, navigation } = kernel.kernelServices

    navigation.navigate({ surface: 'workbench.settings', params: { page: 'skills' } })
    await settle()
    expect(layout.current().auxiliary.activeOwner).toBe(SKILLS_OWNER)
    layout.openPanel('right', 'panels.skill')
    await settle()
    expect(docked()).toBe('true')
    expect(document.querySelector('[data-panel="panels.skill"]')).not.toBeNull()

    navigation.home()
    await settle()
    expect(docked()).toBe('false')

    /* 「打开设置」不带页：解析成缺省的第一页「通用」，归属是通用页自己那一位 */
    navigation.navigate({ surface: 'workbench.settings', params: {} })
    await settle()
    expect(layout.current().auxiliary.activeOwner).toBe(settingsDockOwner('general'))
    expect(docked()).toBe('false')
    layout.togglePanel('right')
    layout.openPanel('right', 'panels.skill')
    await settle()
    expect(docked()).toBe('false')

    navigation.navigate({ surface: 'workbench.settings', params: { page: 'general' } })
    await settle()
    expect(docked()).toBe('false')

    navigation.navigate({ surface: 'workbench.settings', params: { page: 'skills' } })
    await settle()
    expect(docked()).toBe('true')
    expect(document.querySelector('[data-panel="panels.skill"]')).not.toBeNull()
    kernel.dispose()
  })

  test('技能页里换到别的设置页，坞随即离场；认不得的页按缺省页算', async () => {
    const kernel = await mount([workbenchFeature, settingsPagesFeature(), panelsFeature()])
    const { layout, navigation } = kernel.kernelServices

    navigation.navigate({ surface: 'workbench.settings', params: { page: 'skills' } })
    await settle()
    layout.openPanel('right', 'panels.skill')
    await settle()
    expect(docked()).toBe('true')

    navigation.navigate({ surface: 'workbench.settings', params: { page: 'general' } })
    await settle()
    expect(docked()).toBe('false')

    navigation.navigate({ surface: 'workbench.settings', params: { page: 'gone' } })
    await settle()
    expect(layout.current().auxiliary.activeOwner).toBe(settingsDockOwner('general'))
    expect(docked()).toBe('false')
    kernel.dispose()
  })
})

/*
 * R-49：终端改成右坞 dockTabs 组（每条终端一格标签）。钉住的是坞这一侧的三件事：组标签与 pane 标签同条、
 * 启动器 / 加号菜单点组走组自己的 onOpen；标签选中态跟着**画出来的那一格**走；加号菜单打开时不再往面板上方垫让位块。
 */
describe('dockTabs 组与标签选中态（R-49）', () => {
  const settle = () => new Promise((r) => setTimeout(r, 5))
  const tabs = () => [...document.querySelectorAll('[role="tab"]')]
  const selected = () => tabs().filter((t) => t.getAttribute('aria-selected') === 'true')

  function groupFeature() {
    const listeners = new Set<() => void>()
    let entries: { id: string; title: string }[] = []
    let activeId: string | null = null
    const opened: string[] = []
    const emit = () => {
      for (const listener of [...listeners]) {
        listener()
      }
    }
    let snapshot: readonly { id: string; title: string; icon: null; active: boolean }[] = []
    const rebuild = () => {
      snapshot = entries.map((e) => ({ ...e, icon: null, active: e.id === activeId }))
      emit()
    }
    const dockTabs: PanelDockTabs = {
      subscribe: (listener) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
      tabs: () => snapshot,
      onSelect: (id) => {
        activeId = id
        rebuild()
      },
      onClose: (id) => {
        entries = entries.filter((e) => e.id !== id)
        activeId = entries.at(-1)?.id ?? null
        rebuild()
      },
      onOpen: () => {
        const id = `s${entries.length + 1}`
        opened.push(id)
        entries = [...entries, { id, title: `格 ${entries.length + 1}` }]
        activeId = id
        rebuild()
      },
    }
    const feature = defineUiFeature({
      id: 'group',
      setup: (ctx) => {
        ctx.contribute(builtinPoints.panels, {
          id: 'group.shells',
          location: 'right',
          order: 40,
          title: '多格',
          icon: () => <span />,
          dockTabs,
          component: () => <p data-panel="group.shells">多格的正文</p>,
        })
      },
    })
    return { feature, opened, dockTabs }
  }

  test('启动器点组：走组自己的 onOpen，组标签进标签条且选中，画的是组的正文', async () => {
    const { feature, opened } = groupFeature()
    const kernel = await mount([panelsFeature(), feature])
    const { layout } = kernel.kernelServices

    layout.setActiveOwner('t1')
    layout.setDockOpen('t1', true)
    await settle()

    const button = [...document.querySelectorAll('section[aria-label="辅助面板启动器"] button')].find((b) =>
      (b.textContent ?? '').includes('多格'),
    )
    fireEvent.click(button!)
    await settle()

    expect(opened).toEqual(['s1'])
    expect(tabs().map((t) => t.textContent)).toEqual(['格 1'])
    expect(selected().map((t) => t.textContent)).toEqual(['格 1'])
    expect(document.querySelector('[data-panel="group.shells"]')).not.toBeNull()
    kernel.dispose()
  })

  test('选中格指向不在场的 id：正文落到兜底那一格，标签条上亮着的也正是它（有且只有一格）', async () => {
    const kernel = await mount([panelsFeature()])
    const { layout } = kernel.kernelServices

    layout.setActiveOwner('t1')
    layout.openPane('t1', 'panels.review')
    layout.openPane('t1', 'panels.terminal')
    await settle()

    /* focusPane 允许写组 id（不在 ids 里也写）—— 组贡献缺席或组里一格都没有时，activeId 就落空 */
    layout.focusPane('t1', 'group.gone')
    await settle()

    expect(document.querySelector('[data-panel="panels.terminal"]')).not.toBeNull()
    expect(selected().map((t) => t.textContent)).toEqual(['终端'])
    kernel.dispose()
  })

  test('组标签与 pane 标签同条：点哪格亮哪格，正文跟着换，亮着的始终只有一格', async () => {
    const { feature, dockTabs } = groupFeature()
    const kernel = await mount([panelsFeature(), feature])
    const { layout } = kernel.kernelServices

    layout.setActiveOwner('t1')
    layout.openPane('t1', 'panels.review')
    await settle()

    /* 组走代码路径开两格（同终端的 Ctrl+Shift+` 新建）：onOpen 之后把选中格指到组 */
    dockTabs.onOpen()
    dockTabs.onOpen()
    layout.focusPane('t1', 'group.shells')
    await settle()

    expect(tabs().map((t) => t.textContent)).toEqual(['审查', '格 1', '格 2'])
    expect(selected().map((t) => t.textContent)).toEqual(['格 2'])
    expect(document.querySelector('[data-panel="group.shells"]')).not.toBeNull()

    fireEvent.click(tabs()[0]!)
    await settle()
    expect(selected().map((t) => t.textContent)).toEqual(['审查'])
    expect(document.querySelector('[data-panel="panels.review"]')).not.toBeNull()

    fireEvent.click(tabs()[1]!)
    await settle()
    expect(selected().map((t) => t.textContent)).toEqual(['格 1'])
    expect(document.querySelector('[data-panel="group.shells"]')).not.toBeNull()
    kernel.dispose()
  })

  test('加号菜单打开时不往面板上方垫让位块：面板主体仍紧贴标签条', async () => {
    const kernel = await mount([panelsFeature()])
    const { layout } = kernel.kernelServices

    layout.setActiveOwner('t1')
    layout.openPane('t1', 'panels.review')
    await settle()

    const trigger = document.querySelector('button[aria-label="新建标签页"]')
    expect(trigger).not.toBeNull()
    const strip = trigger!.closest('[role="tablist"]')?.parentElement?.parentElement ?? null
    const before = strip?.children.length ?? 0

    await act(async () => {
      fireEvent.click(trigger!)
      await settle()
    })

    expect(document.querySelector('[role="menu"]')).not.toBeNull()
    expect(strip?.children.length ?? 0).toBe(before)
    kernel.dispose()
  })
})
