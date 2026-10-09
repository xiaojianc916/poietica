import { describe, expect, test } from 'bun:test'
import { AppError } from '@poietica/foundation'
import { describeError } from '../services/errors'
import { createLayoutService, DEFAULT_LAYOUT, LAYOUT_LIMITS } from '../services/layout'
import { createNavigationService } from '../services/navigation'
import { createToastService } from '../services/toasts'

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
   * 右坞的开合由**归属**决定（legacy 的 auxiliaryThread === activeConversationId）：
   * 没有前台就别开（命令不该凭空拉出一个空面板），有前台时开一格即在场，
   * toggle 同一格收起、toggle 另一格换过去。
   */
  test('openPanel / togglePanel / closePanel（右坞的归属语义）', () => {
    const l = createLayoutService()

    /* 没有前台：openPanel 是空操作，坞不出现。 */
    l.openPanel('right', 'p1')
    expect(l.current().right.open).toBe(false)
    expect(l.current().right.activeId).toBeNull()

    l.setActiveOwner('t1')
    l.openPanel('right', 'p1')
    expect(l.current().right).toEqual({ open: true, activeId: 'p1', size: DEFAULT_LAYOUT.right.size })
    expect(l.panes.current().byOwner.t1).toEqual({ ids: ['p1'], activeId: 'p1' })

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

describe('toasts', () => {
  test('show / dismiss', () => {
    const t = createToastService({})
    const d = t.show({ severity: 'info', title: '提示' })
    expect(t.current().length).toBe(1)
    d.dispose()
    expect(t.current()).toEqual([])
  })

  test('UK-5 同一条错误 3 秒内重复出现只显示一次', () => {
    const t = createToastService({})
    const err = new AppError('alpha.boom', '炸了')
    t.error(err)
    t.error(err)
    expect(t.current().length).toBe(1)
  })

  test('不同的错误分别显示', () => {
    const t = createToastService({})
    t.error(new AppError('alpha.boom', '炸了'))
    t.error(new AppError('alpha.other', '别的'))
    expect(t.current().length).toBe(2)
  })

  test('最多同时显示 5 条', () => {
    const t = createToastService({})
    for (let i = 0; i < 8; i++) t.show({ severity: 'info', title: `t${i}` })
    expect(t.current().length).toBe(5)
    expect(t.current()[4]!.title).toBe('t7')
  })

  test('error 默认不自动消失，其余 4 秒', () => {
    const t = createToastService({})
    t.error(new AppError('a.b', 'x'))
    expect(t.current()[0]!.durationMs).toBe(0)
    t.show({ severity: 'success', title: 'ok' })
    expect(t.current()[1]!.durationMs).toBe(4_000)
  })

  test('error 用契约文案作标题，服务端 message 作详情', () => {
    const t = createToastService({ 'alpha.boom': '炸了标题' })
    t.error(new AppError('alpha.boom', '细节'))
    expect(t.current()[0]!.title).toBe('炸了标题')
    expect(t.current()[0]!.detail).toBe('细节')
  })

  test('显式 title 时把契约文案拼进详情', () => {
    const t = createToastService({ 'alpha.boom': '炸了标题' })
    t.error(new AppError('alpha.boom', '细节'), '对话失败')
    expect(t.current()[0]!.title).toBe('对话失败')
    expect(t.current()[0]!.detail).toContain('炸了标题')
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
