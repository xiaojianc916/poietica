import { afterEach, describe, expect, test } from 'bun:test'
import { defineServiceToken } from '@poietica/foundation'
import type { RpcMessage, WindowBridge } from '@poietica/rpc'
import {
  builtinPoints,
  createUiKernel,
  defineUiFeature,
  KernelProvider,
  SETTINGS_GROUPS,
  type UiFeature,
  type UiKernel,
  useService,
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
  // 每个用例结束都卸载并清空 body：同一进程里跑多个测试文件时，残留的 DOM 会让
  // document.querySelector 命中上一次渲染的节点，用例之间互相污染。
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

/**
 * CommandMenu 的每一行是 role=option（Base UI Combobox 渲染）。命令 id 由它写进
 * 行的 value 属性，取不到时退回文本 —— 测试只关心「这一行在不在」。
 */
function optionValues(): string[] {
  return [...document.querySelectorAll('[role="option"]')].map((el) => {
    const attrs = el.getAttributeNames()
    const valueAttr = attrs.find((n) => n === 'value' || n.endsWith('-value'))
    const value = valueAttr === undefined ? null : el.getAttribute(valueAttr)
    return value ?? el.textContent ?? ''
  })
}

describe('workbench 外壳', () => {
  /*
   * 13 页 §6 的 P3.5 用例：贡献 2 个段和 4 个页（其中 1 个页的 group 没有注册）
   * → 渲染 3 个 `settings-navigation__items`（最后一个是兜底段），段内按 order 排序，
   * 没有段标题，未知 group 记一条 warn。
   */
  test('设置导航：按段渲染，未知 group 进兜底段并记 warn', async () => {
    const { workbenchFeature } = await import('../feature')
    const feature = defineUiFeature({
      id: 'test',
      setup: (ctx) => {
        // 只贡献 app / agent 两段；第三段（system）由 workbenchFeature 贡献
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
    // 段序：app(100) → test.extra(250) → agent(200)… 按 order 排；兜底段在最后
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
    /* 未注册的表面走 06 页 §6.2 的 UnknownSurface（「该页面不可用」）。 */
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
    // 通过命令面板自己的命令打开它
    await kernel.kernelServices.commands.execute('workbench.commandPalette')
    await new Promise((r) => setTimeout(r, 5))
    // 命令面板已迁移到 design-system 的 Dialog + CommandMenu（legacy 同一条用法），
    // 所以找的是 Base UI Combobox 的输入框与 option，而不是自绘的行。
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
    /* Ctrl+J（切换底部面板）随底坞一起删除：legacy 没有底坞，也没有这条快捷键。 */
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
   * 真实故障：打开设置（`params: {}`）时导航里没有一行是选中的 —— 组合根传的是
   * `route.params.page ?? ''`，空串穿过 `?? ` 落到 activeId 上，第一页的
   * `data-active` 因此不是 `true`。这里把「位于通用页时通用必须是选中态」钉住。
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

  /*
   * 真实故障：进入设置后底部的「帮助 / 设置」两枚图标整排消失 —— 设置那一支侧栏
   * 只渲了导航，没把 legacy 的 SidebarFooter（settingsActive）挂回去。
   */
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

  /*
   * 回归：底部行的「开发者工具」早先被执行两次（SidebarFooter 传回调执行一次、
   * HelpMenu 自己又执行一次），点一下会开两个 DevTools。命令的执行点只允许一处。
   */
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

  /*
   * 回归：帮助菜单里的「更新行」在 legacy 是 `app-shell.tsx` 传给 `SidebarFooter` 的
   * 一个插槽；新架构里换成 `helpMenuItems` 贡献点 —— 但曾经**没有任何功能往里贡献**，
   * 于是菜单里那一行整条消失。这一条钉住「功能贡献的行真的画在项目文档与 GitHub 之间」。
   */
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
    /* DOM 次序就是 legacy 的位置：项目文档 → 贡献行 → GitHub。 */
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

  test('toasts 浮层显示内核服务的提示', async () => {
    const kernel = await mount()
    kernel.kernelServices.toasts.show({ severity: 'info', title: '提示一下' })
    await new Promise((r) => setTimeout(r, 5))
    expect(screen.getByText('提示一下')).toBeDefined()
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
    // 外观归 design-system 的 ConfirmationDialog（见 parts/confirm-host.tsx 的头注），
    // 取消键按可访问名称找，不认实现细节的类名。
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(await answer).toBe(false)
    kernel.dispose()
  })

  /*
   * 用户 2026-10-06 报的「退出时顶部栏下方闪一次 #383836 长方形」：外壳栅格原先多一行
   * `banners`，底色取 `--ui-accent`（深色 #383836）。外壳按 Core 状态挂出整行、组件却
   * 因宽限画不出字，屏幕上就只剩一条没有字的纯色行。那一行已整条删除 —— 横幅改回
   * design-system 的通用 Banner 浮层。这条钉住「外壳里再也不存在那条横幅行」。
   */
  test('外壳不再有横幅行（色块闪现的载体已删除）', async () => {
    const kernel = await mount()
    expect(document.querySelector('[data-workbench-part="banners"]')).toBeNull()
    expect(document.querySelector('.workspace-shell__banners')).toBeNull()
    expect(document.querySelector('[data-workbench-part="title-bar"]')).not.toBeNull()
    kernel.dispose()
  })

  /*
   * 浮层宿主挂在栅格根之内（为了继承 --chrome-height 那类自定义属性），所以它的包装层
   * 必须 display: contents —— 否则一个静态定位的 div 会被栅格**自动放进某个格位**，等于
   * 外壳又替浮层占了一格，正是横幅行那个故障的形状。
   *
   * happy-dom 不做布局，「没占格位」量不出来；这里改为钉住那个前提（包装层的类名在，
   * 且 .workbench__overlay 规则存在），规则本身由 parts.css 保证。
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

  /*
   * 06 页 §6.2 的渲染规则表要求「kernel.failures 非空时显示 N 个功能加载失败，点击弹出列表」。
   * 该条原先是状态栏左端那一格；本设计没有状态栏，横幅区删掉之后它住在**浮层**这一层。
   */
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
    /* 只有抛错那一格显示占位：主区与标题栏照常渲染（title-bar 是外壳家具）。 */
    expect(document.querySelector('[data-workbench-part="title-bar"]')).not.toBeNull()
    expect(document.querySelector('[data-workbench-part="unknown-surface"]')).not.toBeNull()
    kernel.dispose()
  })

  test('useService 在 workbench 里可用（内核服务令牌）', async () => {
    const Token = defineServiceToken<{ hello: string }>('test', 'Thing')
    let got: { hello: string } | undefined
    const feature = defineUiFeature({
      id: 'test',
      setup: (ctx) => {
        ctx.services.provide(Token, { hello: 'world' })
      },
    })
    const feature2 = defineUiFeature({
      id: 'test2',
      dependsOn: ['test'],
      setup: () => undefined,
    })
    const kernel = await mount([feature, feature2])
    function Consumer() {
      got = useService(Token)
      return <span data-consumer>{got.hello}</span>
    }
    void Consumer
    expect(kernel.servicesFor('test2').get(Token).hello).toBe('world')
    kernel.dispose()
  })
})
