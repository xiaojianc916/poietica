import { describe, expect, test } from 'bun:test'
import { AppError } from '@poietica/foundation'
import { createBannerService } from '../services/banners'
import { describeError } from '../services/errors'
import {
  createLayoutService,
  DEFAULT_LAYOUT,
  DEFAULT_PANEL_WIDTH,
  LAYOUT_LIMITS,
  SETTINGS_OWNER,
} from '../services/layout'
import { createNavigationService } from '../services/navigation'

describe('navigation', () => {
  const home = { surface: 'home', params: {} }

  test('navigate 推进历史并更新 canGoBack', () => {
    const n = createNavigationService(home)
    n.navigate({ surface: 'a', params: { id: '1' } })
    expect(n.current().route.surface).toBe('a')
    expect(n.current().canGoBack).toBe(true)
    expect(n.current().canGoForward).toBe(false)
  })

  test('同一路由不重复入栈', () => {
    const n = createNavigationService(home)
    n.navigate({ surface: 'a', params: {} })
    n.navigate({ surface: 'a', params: {} })
    n.back()
    expect(n.current().route.surface).toBe('home')
    expect(n.current().canGoBack).toBe(false)
  })

  test('back / forward', () => {
    const n = createNavigationService(home)
    n.navigate({ surface: 'a', params: {} })
    n.navigate({ surface: 'b', params: {} })
    n.back()
    expect(n.current().route.surface).toBe('a')
    expect(n.current().canGoForward).toBe(true)
    n.forward()
    expect(n.current().route.surface).toBe('b')
  })

  test('back 到头不动', () => {
    const n = createNavigationService(home)
    n.back()
    expect(n.current().route.surface).toBe('home')
  })

  test('restore 不进历史', () => {
    const n = createNavigationService(home)
    n.navigate({ surface: 'a', params: {} })
    n.restore({ surface: 'b', params: {} })
    expect(n.current().route.surface).toBe('b')
    expect(n.current().canGoBack).toBe(false)
  })

  test('home 回到默认路由', () => {
    const n = createNavigationService(home)
    n.navigate({ surface: 'a', params: {} })
    n.home()
    expect(n.current().route.surface).toBe('home')
  })

  test('replace 不写历史', () => {
    const n = createNavigationService(home)
    n.navigate({ surface: 'a', params: {} }, { replace: true })
    expect(n.current().canGoBack).toBe(false)
  })

  test('历史最多 50 条', () => {
    const n = createNavigationService(home)
    for (let i = 0; i < 60; i++) n.navigate({ surface: `s${i}`, params: {} })
    let steps = 0
    while (n.current().canGoBack) {
      n.back()
      steps++
      if (steps > 100) break
    }
    expect(steps).toBe(50)
  })

  test('subscribe 在变化时触发，值相同不触发', () => {
    const n = createNavigationService(home)
    let calls = 0
    n.subscribe(() => {
      calls++
    })
    n.navigate({ surface: 'a', params: {} })
    expect(calls).toBe(1)
  })
})

describe('layout', () => {
  test('切换侧栏', () => {
    const l = createLayoutService()
    expect(l.current().sidebar.visible).toBe(true)
    l.toggleSidebar()
    expect(l.current().sidebar.visible).toBe(false)
  })

  test('侧栏宽度按边界收紧', () => {
    const l = createLayoutService()
    l.setSidebarWidth(10)
    expect(l.current().sidebar.width).toBe(LAYOUT_LIMITS.sidebar[0])
    l.setSidebarWidth(9000)
    expect(l.current().sidebar.width).toBe(LAYOUT_LIMITS.sidebar[1])
    l.setSidebarWidth(300.4)
    expect(l.current().sidebar.width).toBe(300)
  })

  /*
   * 右坞的开合由**归属**决定：没有前台就别开（命令不该凭空拉出一个空面板），
   * 有前台时开一格即在场，toggle 同一格收起、toggle 另一格换过去。
   */
  test('openPanel / togglePanel / closePanel（右坞的归属语义）', () => {
    const l = createLayoutService()

    l.openPanel('right', 'p1')
    expect(l.current().right.open).toBe(false)
    expect(l.current().right.activeId).toBeNull()

    l.setActiveOwner('t1')
    l.openPanel('right', 'p1')
    expect(l.current().right).toEqual({ open: true, activeId: 'p1', size: DEFAULT_LAYOUT.right.size })
    expect(l.panes.current().byOwner.t1).toEqual({ ids: ['p1'], activeId: 'p1', open: true })

    l.togglePanel('right', 'p1')
    expect(l.current().right.open).toBe(false)

    l.togglePanel('right', 'p1')
    expect(l.current().right.open).toBe(true)

    l.openPanel('right', 'p2')
    expect(l.current().right.activeId).toBe('p2')
    expect(l.panes.current().byOwner.t1?.ids).toEqual(['p1', 'p2'])

    l.closePanel('right')
    expect(l.current().right.open).toBe(false)
  })

  /*
   * 坞按归属分账：开合、格清单、选中格都是每个归属自己的。内容归属（auxiliary.owner）在前台的坞没开时保持上一位，
   * 收起 / 换前台的过渡期间坞里的内容不换人。
   */
  test('各归属各记开合；换前台时内容归属保持上一位', () => {
    const l = createLayoutService()

    l.setActiveOwner('t1')
    l.openPanel('right', 'p1')
    l.setActiveOwner('t2')
    expect(l.current().right.open).toBe(false)
    expect(l.current().auxiliary.owner).toBe('t1')

    l.togglePanel('right')
    expect(l.current().right.open).toBe(true)
    expect(l.current().auxiliary.owner).toBe('t2')
    l.closePanel('right')

    l.setActiveOwner('t1')
    expect(l.current().right).toEqual({ open: true, activeId: 'p1', size: DEFAULT_LAYOUT.right.size })
    expect(l.panes.current().byOwner.t2?.open).toBe(false)
  })

  test('面板的归属类别：设置页只收 settings 的格，对话只收 surface 的格；设置页关掉最后一格即收起', () => {
    const scopes: Record<string, 'surface' | 'settings'> = { skill: 'settings', browser: 'surface' }
    const l = createLayoutService({ scopeOf: (id) => scopes[id] })

    l.setActiveOwner(SETTINGS_OWNER)
    l.openPanel('right', 'browser')
    l.togglePanel('right')
    expect(l.current().right.open).toBe(false)

    l.openPanel('right', 'skill')
    expect(l.current().right).toMatchObject({ open: true, activeId: 'skill' })
    l.closePane(SETTINGS_OWNER, 'skill')
    expect(l.current().right.open).toBe(false)

    l.setActiveOwner('t1')
    l.openPanel('right', 'skill')
    l.focusPane('t1', 'skill')
    expect(l.panes.current().byOwner.t1).toBeUndefined()
    l.openPanel('right', 'browser')
    expect(l.current().right).toMatchObject({ open: true, activeId: 'browser' })
  })

  test('forgetOwner：清掉那一份坞，内容归属与前台引用一起清', () => {
    const l = createLayoutService()
    l.setActiveOwner('t1')
    l.openPanel('right', 'p1')

    l.forgetOwner('t1')
    expect(l.panes.current().byOwner.t1).toBeUndefined()
    expect(l.current().auxiliary).toEqual({ owner: null, activeOwner: null, fullscreen: false })
    expect(l.current().right.open).toBe(false)
  })

  /*
   * 读盘是异步的，常常晚于外壳第一次写前台：清掉 activeOwner 会让启动后第一屏对话的坞一直不出来。
   * 设置页那一位不补开合：技能文档是随文档现开的瞬时格，重启后没有可看的文档。
   */
  test('restore：保留当前前台；存盘时在场的那一位补开合；设置页不补', () => {
    const l = createLayoutService()
    l.setActiveOwner('t1')
    l.restore({ right: { open: true, size: 600 }, auxiliary: { owner: 't1' } })
    expect(l.current().auxiliary.activeOwner).toBe('t1')
    expect(l.current().right).toEqual({ open: true, activeId: null, size: 600 })

    const s = createLayoutService()
    s.restore({ right: { open: true, size: 600 }, auxiliary: { owner: SETTINGS_OWNER } })
    s.setActiveOwner(SETTINGS_OWNER)
    expect(s.current().right.open).toBe(false)
    expect(s.panes.current().byOwner[SETTINGS_OWNER]).toBeUndefined()
  })

  test('右坞默认宽度 560：AI 拉起内置浏览器时网页不至于只剩一条窄页', () => {
    expect(DEFAULT_LAYOUT.right.size).toBe(DEFAULT_PANEL_WIDTH)
    expect(DEFAULT_PANEL_WIDTH).toBe(560)
  })

  test('面板尺寸按边界收紧', () => {
    const l = createLayoutService()
    l.setPanelSize('right', 1)
    expect(l.current().right.size).toBe(LAYOUT_LIMITS.right[0])
    l.setPanelSize('right', 99_999)
    expect(l.current().right.size).toBe(LAYOUT_LIMITS.right[1])
  })

  test('restore 用默认值填充非法输入', () => {
    const l = createLayoutService()
    l.restore({ sidebar: { visible: 'yes', width: 'x' } })
    expect(l.current().sidebar.visible).toBe(true)
    expect(l.current().sidebar.width).toBe(280)
  })

  test('restore 对超界值做收紧', () => {
    const l = createLayoutService()
    l.restore({ sidebar: { visible: false, width: 10_000 } })
    expect(l.current().sidebar.width).toBe(LAYOUT_LIMITS.sidebar[1])
    expect(l.current().sidebar.visible).toBe(false)
  })

  test('restore(null) 得到默认布局', () => {
    const l = createLayoutService()
    l.toggleSidebar()
    l.restore(null)
    expect(l.current()).toEqual(DEFAULT_LAYOUT)
  })
})

describe('banners', () => {
  test('show / dismiss', () => {
    const b = createBannerService({})
    const d = b.show({ severity: 'info', title: '提示' })
    expect(b.current().length).toBe(1)
    d.dispose()
    expect(b.current()).toEqual([])
  })

  test('UK-5 同一条错误 3 秒内重复出现只显示一次', () => {
    const b = createBannerService({})
    const err = new AppError('alpha.boom', '炸了')
    b.error(err)
    b.error(err)
    expect(b.current().length).toBe(1)
  })

  test('后一条替换前一条：屏幕上只留最新这一条', () => {
    const b = createBannerService({})
    b.show({ severity: 'info', title: '第一条' })
    b.show({ severity: 'success', title: '第二条' })
    expect(b.current().map((n) => n.title)).toEqual(['第二条'])
  })

  test('默认停留时长：错误 6 秒，其余 4 秒', () => {
    const b = createBannerService({})
    b.error(new AppError('a.b', 'x'))
    expect(b.current()[0]!.holdMs).toBe(6_000)
    b.show({ severity: 'success', title: 'ok' })
    expect(b.current()[0]!.holdMs).toBe(4_000)
  })

  test('error 用契约文案作标题，服务端 message 作详情', () => {
    const b = createBannerService({ 'alpha.boom': '炸了标题' })
    b.error(new AppError('alpha.boom', '细节'))
    expect(b.current()[0]!.title).toBe('炸了标题')
    expect(b.current()[0]!.detail).toBe('细节')
  })

  test('显式 title 时把契约文案拼进详情', () => {
    const b = createBannerService({ 'alpha.boom': '炸了标题' })
    b.error(new AppError('alpha.boom', '细节'), '对话失败')
    expect(b.current()[0]!.title).toBe('对话失败')
    expect(b.current()[0]!.detail).toContain('炸了标题')
  })
})

describe('describeError', () => {
  test('AppError 用契约文案', () => {
    expect(describeError(new AppError('a.b', 'x'), { 'a.b': '标题' })).toEqual({
      code: 'a.b',
      title: '标题',
      detail: 'x',
    })
  })
  test('未知错误归为操作失败', () => {
    expect(describeError(new Error('x'), {})).toEqual({ code: 'kernel.internal', title: '操作失败', detail: 'x' })
  })
  test('非 Error 值转字符串', () => {
    expect(describeError('boom', {})).toEqual({ code: 'kernel.internal', title: '操作失败', detail: 'boom' })
  })
  test('没有文案时用默认标题', () => {
    expect(describeError(new AppError('a.b', 'x'), {}).title).toBe('操作失败')
  })
})
