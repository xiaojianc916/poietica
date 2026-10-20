import { afterEach, describe, expect, test } from 'bun:test'
import { overlaysOnScreen } from '@poietica/design-system'
import type { RpcMessage, WindowBridge } from '@poietica/rpc'
import {
  builtinPoints,
  createUiKernel,
  defineUiFeature,
  KernelProvider,
  SETTINGS_GROUPS,
  type UiFeature,
  type UiKernel,
} from '@poietica/ui-kernel'
import { cleanup, render, screen } from '@testing-library/react'
import { Workbench } from '../workbench'

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

afterEach(() => {
  // 每个用例结束都卸载并清空 body：残留 DOM 会让 document.querySelector 命中上一次渲染的节点，用例互相污染。
  cleanup()
  document.body.innerHTML = ''
})

async function mount(features: readonly UiFeature[] = []): Promise<UiKernel> {
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

/** 命令 id 由 Base UI Combobox 写进 role=option 行的 value 属性，取不到时退回文本。 */
function optionValues(): string[] {
  return [...document.querySelectorAll('[role="option"]')].map((el) => {
    const attrs = el.getAttributeNames()
    const valueAttr = attrs.find((n) => n === 'value' || n.endsWith('-value'))
    const value = valueAttr === undefined ? null : el.getAttribute(valueAttr)
    return value ?? el.textContent ?? ''
  })
}

describe('workbench 外壳', () => {
  test('设置导航：按段渲染，未知 group 进兜底段并记 warn', async () => {
    const { workbenchFeature } = await import('../feature')
    const feature = defineUiFeature({
      id: 'test',
      setup: (ctx) => {
        ctx.contribute(builtinPoints.settingsGroups, { id: 'test.extra', order: 250 })
        ctx.contribute(builtinPoints.settingsPages, {
          id: 'test.a',
          group: SETTINGS_GROUPS.app,
          order: 1,
          title: 'A',
          icon: () => <span />,
          component: () => <p />,
        })
        ctx.contribute(builtinPoints.settingsPages, {
          id: 'test.b',
          group: 'test.extra',
          order: 3,
          title: 'B',
          icon: () => <span />,
          component: () => <p />,
        })
        ctx.contribute(builtinPoints.settingsPages, {
          id: 'test.c',
          group: 'test.extra',
          order: 2,
          title: 'C',
          icon: () => <span />,
          component: () => <p />,
        })
        /* group 没有注册 → 兜底段 */
        ctx.contribute(builtinPoints.settingsPages, {
          id: 'test.orphan',
          group: 'nobody.declared.this',
          order: 1,
          title: '孤儿页',
          icon: () => <span />,
          component: () => <p />,
        })
      },
    })
    const kernel = await mount([workbenchFeature, feature])
    kernel.kernelServices.navigation.navigate({ surface: 'workbench.settings', params: {} })
    await new Promise((r) => setTimeout(r, 5))

    const sections = [...document.querySelectorAll('.settings-navigation__items')]
    // 段按 order 升序；兜底段在最后
    const last = sections.at(-1)
    expect(last?.querySelector('[data-settings-page="test.orphan"]')).not.toBeNull()

    const extra = sections.find((s) => s.querySelector('[data-settings-page="test.b"]') !== null)
    const ids = [...(extra?.querySelectorAll('[data-settings-page]') ?? [])].map((el) =>
      el.getAttribute('data-settings-page'),
    )
    expect(ids).toEqual(['test.c', 'test.b'])
    kernel.dispose()
  })

  test('没有任何功能时外壳正常渲染，所有区域显示空状态', async () => {
    const kernel = await mount()
    expect(document.querySelector('[data-workbench]')).not.toBeNull()
    expect(document.querySelector('[data-workbench-part="title-bar"]')).not.toBeNull()
    expect(document.querySelector('[data-empty="sidebar"]')).not.toBeNull()
    /* 未注册的表面走 UnknownSurface（「该页面不可用」）。 */
    expect(document.querySelector('[data-workbench-part="unknown-surface"]')).not.toBeNull()
    kernel.dispose()
  })

  test('注册一个测试功能，它贡献的侧栏项和主区界面能出现', async () => {
    const feature = defineUiFeature({
      id: 'test',
      setup: (ctx) => {
        ctx.contribute(builtinPoints.sidebarSections, {
          id: 'test.sidebar',
          order: 1,
          title: '测试',
          component: () => <p data-test-sidebar>侧栏内容</p>,
        })
        ctx.contribute(builtinPoints.surfaces, {
          id: 'home',
          title: '首页',
          component: () => <p data-test-main>主区内容</p>,
        })
      },
    })
    const kernel = await mount([feature])
    expect(document.querySelector('[data-test-sidebar]')).not.toBeNull()
    expect(document.querySelector('[data-test-main]')).not.toBeNull()
    expect(document.querySelector('[data-empty="sidebar"]')).toBeNull()
    kernel.dispose()
  })

  test('命令面板能搜索并执行命令', async () => {
    const ran: string[] = []
    const { workbenchFeature } = await import('../feature')
    const feature = defineUiFeature({
      id: 'test',
      setup: (ctx) => {
        ctx.contribute(builtinPoints.commands, {
          id: 'test.hello',
          title: '打个招呼',
          category: '测试',
          run: () => {
            ran.push('hello')
          },
        })
      },
    })
    const kernel = await mount([workbenchFeature, feature])
    await kernel.kernelServices.commands.execute('workbench.commandPalette')
    await new Promise((r) => setTimeout(r, 5))
    // 面板用 design-system 的 CommandMenu，所以找的是 Base UI Combobox 的输入框与 option。
    const input = document.querySelector<HTMLInputElement>('[role="combobox"]')
    expect(input).not.toBeNull()
    expect(optionValues().some((v) => v.includes('test.hello'))).toBe(true)
    expect(optionValues().some((v) => v.includes('workbench.commandPalette'))).toBe(true)
    kernel.dispose()
  })

  test('命令面板输入过滤', async () => {
    const { workbenchFeature } = await import('../feature')
    const feature = defineUiFeature({
      id: 'test',
      setup: (ctx) => {
        ctx.contribute(builtinPoints.commands, { id: 'test.hello', title: '打个招呼', run: () => undefined })
        ctx.contribute(builtinPoints.commands, { id: 'test.bye', title: '再见', run: () => undefined })
      },
    })
    const kernel = await mount([workbenchFeature, feature])
    await kernel.kernelServices.commands.execute('workbench.commandPalette')
    await new Promise((r) => setTimeout(r, 5))
    const input = document.querySelector<HTMLInputElement>('[role="combobox"]')!
    const { fireEvent } = await import('@testing-library/react')
    fireEvent.change(input, { target: { value: '再见' } })
    await new Promise((r) => setTimeout(r, 5))
    const values = optionValues()
    expect(values.some((v) => v.includes('再见'))).toBe(true)
    expect(values.some((v) => v.includes('打个招呼'))).toBe(false)
    kernel.dispose()
  })

  /* 回归：入口页没有当前对话，删除 / 导出这类命令点下去没有任何反应 —— 它们自报 enabled 为假，面板就不该画。 */
  test('命令面板不画此刻用不了的命令', async () => {
    const { workbenchFeature } = await import('../feature')
    const feature = defineUiFeature({
      id: 'test',
      setup: (ctx) => {
        ctx.contribute(builtinPoints.commands, {
          id: 'test.off',
          title: '用不了的命令',
          run: () => undefined,
          enabled: () => false,
        })
        ctx.contribute(builtinPoints.commands, { id: 'test.on', title: '能用的命令', run: () => undefined })
      },
    })
    const kernel = await mount([workbenchFeature, feature])
    await kernel.kernelServices.commands.execute('workbench.commandPalette')
    await new Promise((r) => setTimeout(r, 5))
    const values = optionValues()
    expect(values.some((v) => v.includes('能用的命令'))).toBe(true)
    expect(values.some((v) => v.includes('用不了的命令'))).toBe(false)
    kernel.dispose()
  })

  test('workbenchFeature 贡献命令、快捷键与设置表面', async () => {
    const { workbenchFeature } = await import('../feature')
    const kernel = await mount([workbenchFeature])
    const commands = kernel.registry.list(builtinPoints.commands).map((c) => c.item.id)
    for (const id of [
      'workbench.commandPalette',
      'workbench.toggleSidebar',
      'workbench.toggleRightPanel',
      'workbench.openSettings',
      'workbench.back',
      'workbench.forward',
      'workbench.home',
    ]) {
      expect(commands).toContain(id)
    }
    expect(kernel.registry.list(builtinPoints.surfaces).map((c) => c.item.id)).toContain('workbench.settings')
    expect(kernel.registry.list(builtinPoints.keybindings).length).toBeGreaterThanOrEqual(7)
    kernel.dispose()
  })

  test('打开设置表面：没有设置页时显示空状态', async () => {
    const { workbenchFeature } = await import('../feature')
    const kernel = await mount([workbenchFeature])
    kernel.kernelServices.navigation.navigate({ surface: 'workbench.settings', params: {} })
    await new Promise((r) => setTimeout(r, 5))
    expect(document.querySelector('[data-empty="settings-pages"]')).not.toBeNull()
    kernel.dispose()
  })

  test('设置表面：注册两个设置页，路由参数选中对应页', async () => {
    const { workbenchFeature } = await import('../feature')
    const feature = defineUiFeature({
      id: 'test',
      setup: (ctx) => {
        ctx.contribute(builtinPoints.settingsPages, {
          id: 'test.first',
          group: SETTINGS_GROUPS.app,
          order: 1,
          title: '第一页',
          icon: () => <span />,
          component: () => <p data-page="first">第一页内容</p>,
        })
        ctx.contribute(builtinPoints.settingsPages, {
          id: 'test.second',
          group: SETTINGS_GROUPS.app,
          order: 2,
          title: '第二页',
          icon: () => <span />,
          component: () => <p data-page="second">第二页内容</p>,
        })
      },
    })
    const kernel = await mount([workbenchFeature, feature])
    kernel.kernelServices.navigation.navigate({ surface: 'workbench.settings', params: {} })
    await new Promise((r) => setTimeout(r, 5))
    expect(document.querySelector('[data-page="first"]')).not.toBeNull()
    kernel.kernelServices.navigation.navigate({ surface: 'workbench.settings', params: { page: 'test.second' } })
    await new Promise((r) => setTimeout(r, 5))
    expect(document.querySelector('[data-page="second"]')).not.toBeNull()
    kernel.dispose()
  })

  /*
   * 真实故障：打开设置（`params: {}`）时导航里没有一行选中 —— 组合根传的
   * `route.params.page ?? ''` 让空串落到 activeId 上，第一页的 `data-active` 因此不是 `true`。
   */
  test('设置表面：params 为空时第一页是选中态（空串不算「指定了页」）', async () => {
    const { workbenchFeature } = await import('../feature')
    const feature = defineUiFeature({
      id: 'test',
      setup: (ctx) => {
        ctx.contribute(builtinPoints.settingsPages, {
          id: 'test.first',
          group: SETTINGS_GROUPS.app,
          order: 1,
          title: '第一页',
          icon: () => <span />,
          component: () => <p data-page="first">第一页内容</p>,
        })
        ctx.contribute(builtinPoints.settingsPages, {
          id: 'test.second',
          group: SETTINGS_GROUPS.app,
          order: 2,
          title: '第二页',
          icon: () => <span />,
          component: () => <p data-page="second">第二页内容</p>,
        })
      },
    })
    const kernel = await mount([workbenchFeature, feature])
    kernel.kernelServices.navigation.navigate({ surface: 'workbench.settings', params: {} })
    await new Promise((r) => setTimeout(r, 5))
    const first = document.querySelector('[data-settings-page="test.first"]')
    const second = document.querySelector('[data-settings-page="test.second"]')
    expect(first?.getAttribute('data-active')).toBe('true')
    expect(second?.getAttribute('data-active')).toBe('false')
    kernel.dispose()
  })

  /* 真实故障：进入设置后底部的「帮助 / 设置」两枚图标整排消失 —— 设置那一支侧栏没把 SidebarFooter 挂回去。 */
  test('设置表面：侧栏底部行（帮助与设置）仍在，且设置是高亮态', async () => {
    const { workbenchFeature } = await import('../feature')
    const kernel = await mount([workbenchFeature])
    kernel.kernelServices.navigation.navigate({ surface: 'workbench.settings', params: {} })
    await new Promise((r) => setTimeout(r, 5))
    const footer = document.querySelector('.settings-navigation__footer')
    expect(footer).not.toBeNull()
    expect(footer?.querySelector('[aria-label="帮助"]')).not.toBeNull()
    const settings = footer?.querySelector('[aria-label="设置"]')
    expect(settings).not.toBeNull()
    expect(settings?.className).toContain('bg-sidebar-accent')
    kernel.dispose()
  })

  /* 回归：命令的执行点只允许一处 —— 早先 SidebarFooter 与 HelpMenu 各执行一次，点一下会开两个 DevTools。 */
  test('帮助菜单的「开发者工具」只执行一次', async () => {
    const calls: string[] = []
    const spy = defineUiFeature({
      id: 'spy',
      setup: (ctx) => {
        ctx.contribute(builtinPoints.commands, {
          id: 'platform.openDevtools',
          title: '打开开发者工具',
          run: () => {
            calls.push('openDevtools')
          },
        })
      },
    })
    const kernel = await mount([spy])

    const help = document.querySelector('[aria-label="帮助"]')
    expect(help).not.toBeNull()
    help?.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 }))
    help?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    await new Promise((r) => setTimeout(r, 20))

    const row = [...document.querySelectorAll('[role="menuitem"]')].find((el) =>
      (el.textContent ?? '').includes('开发者工具'),
    )
    expect(row).toBeDefined()
    row?.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 }))
    row?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    await new Promise((r) => setTimeout(r, 20))

    expect(calls).toEqual(['openDevtools'])
    kernel.dispose()
  })

  /* 回归：`helpMenuItems` 曾经没有任何功能往里贡献，菜单里那一行整条消失。 */
  test('帮助菜单渲染功能贡献的行（位置在项目文档与 GitHub 之间）', async () => {
    const feature = defineUiFeature({
      id: 'test',
      setup: (ctx) => {
        ctx.contribute(builtinPoints.helpMenuItems, {
          id: 'test.check',
          order: 100,
          component: () => <span data-test-help-row>检查更新</span>,
        })
      },
    })
    const kernel = await mount([feature])

    const help = document.querySelector('[aria-label="帮助"]')
    expect(help).not.toBeNull()
    help?.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 }))
    help?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    await new Promise((r) => setTimeout(r, 20))

    const row = document.querySelector('[data-test-help-row]')
    expect(row).not.toBeNull()
    /* 次序：项目文档 → 贡献行 → GitHub。 */
    const item = (label: string): Element => {
      const found = [...document.querySelectorAll('[role="menuitem"]')].find((el) =>
        (el.textContent ?? '').includes(label),
      )
      if (found === undefined) throw new Error(`菜单里没有 ${label}`)
      return found
    }
    const docs = item('项目文档')
    const github = item('GitHub')
    expect(docs.compareDocumentPosition(row!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(row!.compareDocumentPosition(github) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    kernel.dispose()
  })

  test('内核通知落在顶部横幅，不再有右下角通知区', async () => {
    const kernel = await mount()
    kernel.kernelServices.banners.show({ severity: 'info', title: '提示一下' })
    await new Promise((r) => setTimeout(r, 5))
    expect(screen.getByText('提示一下')).toBeDefined()
    expect(document.querySelector('.ui-banner')).not.toBeNull()
    expect(document.querySelector('[data-workbench-part="toasts"]')).toBeNull()
    /* 横幅同样登记为贴边浮层：压在浏览器面板的原生视图上时必须让路（P-07）。 */
    const anchored = overlaysOnScreen().flatMap((overlay) =>
      overlay.kind === 'anchored' ? [overlay.element.textContent ?? ''] : [],
    )
    expect(anchored.some((text) => text.includes('提示一下'))).toBe(true)
    cleanup()
    expect(overlaysOnScreen()).toEqual([])
    kernel.dispose()
  })

  test('确认框：队首显示，点击取消后消失', async () => {
    const kernel = await mount()
    const answer = kernel.kernelServices.dialogs.confirm({
      title: '确定吗',
      body: '要做到这一步？',
      confirmLabel: '确定',
    })
    await new Promise((r) => setTimeout(r, 5))
    expect(screen.getByText('确定吗')).toBeDefined()
    const { fireEvent } = await import('@testing-library/react')
    // 取消键按可访问名称找，不认实现细节的类名。
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(await answer).toBe(false)
    kernel.dispose()
  })

  /*
   * 包装层必须 display: contents，否则静态定位的 div 会被栅格自动放进某个格位，等于外壳替浮层占了一格。
   * happy-dom 不做布局，「没占格位」量不出来，这里改为钉住那个前提。
   */
  test('浮层包装层不生成盒子（display: contents）', async () => {
    const feature = defineUiFeature({
      id: 'test',
      setup: (ctx) => {
        ctx.contribute(builtinPoints.overlays, {
          id: 'test.overlay',
          order: 1,
          component: () => <span data-test-overlay>浮层内容</span>,
          useVisible: () => true,
        })
      },
    })
    const kernel = await mount([feature])
    const host = document.querySelector('[data-overlay="test.overlay"]')
    expect(host).not.toBeNull()
    expect(host?.classList.contains('workbench__overlay')).toBe(true)
    kernel.dispose()
  })

  test('useVisible 为假时连包装都不挂', async () => {
    const feature = defineUiFeature({
      id: 'test',
      setup: (ctx) => {
        ctx.contribute(builtinPoints.overlays, {
          id: 'test.hidden',
          order: 1,
          component: () => <span data-test-overlay>不该出现</span>,
          useVisible: () => false,
        })
      },
    })
    const kernel = await mount([feature])
    expect(document.querySelector('[data-overlay="test.hidden"]')).toBeNull()
    expect(document.querySelector('[data-test-overlay]')).toBeNull()
    kernel.dispose()
  })

  /* kernel.failures 非空时显示 N 个功能加载失败，点击弹出列表；它住在浮层这一层。 */
  test('功能加载失败时浮层显示失败计数', async () => {
    const bad = defineUiFeature({
      id: 'bad',
      setup: () => {
        throw new Error('炸了')
      },
    })
    const kernel = await mount([bad])
    expect(document.querySelector('[data-feature-failures="1"]')).not.toBeNull()
    kernel.dispose()
  })

  test('功能组件抛错：只有该区域显示错误占位，其余界面正常', async () => {
    const feature = defineUiFeature({
      id: 'test',
      setup: (ctx) => {
        ctx.contribute(builtinPoints.sidebarSections, {
          id: 'test.boom',
          order: 1,
          title: '坏的',
          component: () => {
            throw new Error('侧栏炸了')
          },
        })
      },
    })
    const kernel = await mount([feature])
    expect(document.querySelector('[data-feature-error="test"]')).not.toBeNull()
    /* 只有抛错那一格显示占位，其余照常渲染。 */
    expect(document.querySelector('[data-workbench-part="title-bar"]')).not.toBeNull()
    expect(document.querySelector('[data-workbench-part="unknown-surface"]')).not.toBeNull()
    kernel.dispose()
  })
})
