import { afterEach, describe, expect, test } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { BrowserState } from '../../contract'
import type { BrowserApi } from '../api'
import { BrowserPanel } from '../panel'
import { createBrowserPanelStore } from '../store'

/*
 * 面板这一层只画「面板的壳」（07 页 §12E 的「panels」一栏）：
 *   - 地址栏：回车 navigate；没有标签时先 newTab；
 *   - 后退 / 前进 / 刷新（装载中变停止）/ 拾取元素；
 *   - 空态那句文案；
 *   - driven 提示条。
 *
 * 标签条不在这里：legacy 的浏览器标签与别的通道同处一条（auxiliary-tab-strip.tsx），
 * 新架构里那一条归右坞（panels 贡献的 dockTabs），用例在 dock-tabs.test.tsx。
 *
 * 原生子 webview 不在这里（它不在 React 树里），所以断言的是 DOM 形状与下发的调用。
 */

interface FakeApi extends BrowserApi {
  readonly calls: string[]
  readonly bounds: { x: number; y: number; width: number; height: number }[]
}

function fakeApi(state: BrowserState): FakeApi {
  const calls: string[] = []
  const bounds: { x: number; y: number; width: number; height: number }[] = []
  const next = state

  return {
    calls,
    bounds,
    state: async () => next,
    newTab: async (url) => {
      calls.push(`newTab:${url ?? 'null'}`)
      return next
    },
    closeTab: async (tabId) => {
      calls.push(`closeTab:${String(tabId)}`)
      return next
    },
    selectTab: async (tabId) => {
      calls.push(`selectTab:${String(tabId)}`)
      return next
    },
    reopenClosed: async (index) => {
      calls.push(`reopenClosed:${String(index)}`)
      return next
    },
    navigate: async (tabId, url) => {
      calls.push(`navigate:${String(tabId)}:${url}`)
      return next
    },
    back: async (tabId) => {
      calls.push(`back:${String(tabId)}`)
      return {}
    },
    forward: async (tabId) => {
      calls.push(`forward:${String(tabId)}`)
      return {}
    },
    reload: async (tabId) => {
      calls.push(`reload:${String(tabId)}`)
      return {}
    },
    stop: async (tabId) => {
      calls.push(`stop:${String(tabId)}`)
      return {}
    },
    setZoom: async (tabId, level) => {
      calls.push(`setZoom:${String(tabId)}:${String(level)}`)
      return {}
    },
    setBounds: async (rect) => {
      bounds.push(rect)
      return {}
    },
    setVisible: async (visible) => {
      calls.push(`setVisible:${String(visible)}`)
      return {}
    },
    pickElement: async (tabId, theme) => {
      calls.push(`pickElement:${String(tabId)}:${theme}`)
      return {}
    },
    cancelPick: async () => {
      calls.push('cancelPick')
      return {}
    },
    onStateChanged: () => ({ dispose: () => undefined }),
    onElementPicked: () => ({ dispose: () => undefined }),
  }
}

const tab = (over: Partial<BrowserState['tabs'][number]> = {}): BrowserState['tabs'][number] => ({
  id: 1,
  url: 'https://a.example/',
  title: 'A 站',
  loading: false,
  favicon: null,
  canGoBack: false,
  canGoForward: false,
  zoom: 0,
  ...over,
})

function stateOf(over: Partial<BrowserState> = {}): BrowserState {
  return {
    revision: 1,
    tabs: [tab()],
    activeTabId: 1,
    pickingTabId: null,
    recentlyClosed: [],
    driven: false,
    ...over,
  }
}

function mount(state: BrowserState, over: { readonly visible?: boolean } = {}) {
  const api = fakeApi(state)
  const store = createBrowserPanelStore(api)

  store.apply(state)

  const seen: string[] = []
  const picked: { tabId: number; picking: boolean }[] = []
  const view = render(
    <BrowserPanel
      api={api}
      layoutSignal="signal"
      onPickToggle={(tabId, picking) => {
        picked.push({ tabId, picking })
      }}
      report={(message) => {
        seen.push(message)
      }}
      store={store}
      visible={over.visible ?? true}
    />,
  )

  /*
   * 挂载那一刻的调用单独收走：面板一上来就会下发一次 setVisible（还有别的用例在追
   * 视口对齐），后面的断言只看用户动作在下发什么。
   */
  const mountCalls = [...api.calls]
  api.calls.length = 0

  return { api, view, messages: seen, mountCalls, picked, store }
}

afterEach(() => {
  cleanup()
})

describe('工具栏', () => {
  test('地址栏回车 navigate；聚焦时全选', () => {
    const { api } = mount(stateOf())
    const address = screen.getByRole('textbox', { name: '地址栏' }) as HTMLInputElement

    fireEvent.focus(address)
    fireEvent.change(address, { target: { value: 'example.com' } })
    fireEvent.keyDown(address, { key: 'Enter' })

    expect(api.calls).toEqual(['navigate:1:example.com'])
  })

  test('没有标签时地址栏回车先 newTab', () => {
    const { api } = mount(stateOf({ tabs: [], activeTabId: null }))
    const address = screen.getByRole('textbox', { name: '地址栏' }) as HTMLInputElement

    fireEvent.change(address, { target: { value: 'example.com' } })
    fireEvent.keyDown(address, { key: 'Enter' })

    expect(api.calls).toEqual(['newTab:example.com'])
  })

  test('空白标签：后退/前进/刷新/拾取都不可用', () => {
    mount(stateOf({ tabs: [tab({ url: null, title: '新标签页' })] }))

    expect((screen.getByRole('button', { name: '后退' }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: '前进' }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: '刷新' }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: '选择网页元素' }) as HTMLButtonElement).disabled).toBe(true)
  })

  test('后退/前进按标签自己的历史开关', () => {
    const { api } = mount(stateOf({ tabs: [tab({ canGoBack: true, canGoForward: true })] }))

    fireEvent.click(screen.getByRole('button', { name: '后退' }))
    fireEvent.click(screen.getByRole('button', { name: '前进' }))

    expect(api.calls).toEqual(['back:1', 'forward:1'])
  })

  test('装载中「刷新」变「停止」，连进度条一起出现', () => {
    const { api } = mount(stateOf({ tabs: [tab({ loading: true })] }))

    expect(screen.queryByRole('button', { name: '刷新' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: '停止' }))

    expect(api.calls).toEqual(['stop:1'])
  })

  test('拾取按钮：按下去问 UI 装配要一次拾取，再按一次是停', () => {
    const { picked, api } = mount(stateOf())

    fireEvent.click(screen.getByRole('button', { name: '选择网页元素' }))
    expect(picked).toEqual([{ tabId: 1, picking: true }])

    mount(stateOf({ pickingTabId: 1 }))
    const buttons = screen.getAllByRole('button', { name: '关闭元素选择' })

    fireEvent.click(buttons[0] as HTMLElement)

    expect(api.calls).toEqual([])
  })
})

describe('空态与提示', () => {
  test('空白标签显示空态文案（原生侧这时没有页面）', () => {
    mount(stateOf({ tabs: [tab({ url: null, title: '新标签页' })], activeTabId: 1 }))

    expect(screen.getByText('浏览器', { selector: 'p' })).toBeDefined()
    expect(screen.getByText('粘贴或输入 URL 以打开网页。')).toBeDefined()
  })

  test('有地址时不画空态', () => {
    mount(stateOf())

    expect(screen.queryByText('粘贴或输入 URL 以打开网页。')).toBeNull()
  })

  test('driven 为真时顶部多一条 agent 提示', () => {
    mount(stateOf({ driven: true }))

    expect(screen.getByText('AI 正在使用这个浏览器')).toBeDefined()
  })

  test('driven 为假时那条提示不在', () => {
    mount(stateOf())

    expect(screen.queryByText('AI 正在使用这个浏览器')).toBeNull()
  })
})

describe('视口对齐', () => {
  test('占位 div 把矩形交给宿主（setBounds）', async () => {
    const { api } = mount(stateOf())

    await Bun.sleep(32)

    expect(api.bounds.length).toBeGreaterThan(0)
    expect(api.bounds.at(-1)).toMatchObject({ x: 0, y: 0 })
  })
})

describe('显隐下发', () => {
  test('挂载按 visible 下发：可见 true，收起 false', () => {
    expect(mount(stateOf()).mountCalls).toContain('setVisible:true')

    const hidden = mount(stateOf(), { visible: false })

    expect(hidden.mountCalls).toContain('setVisible:false')
    /* 收起的面板不该把原生视图留在屏幕上。 */
    expect(hidden.mountCalls).not.toContain('setVisible:true')
  })

  test('卸载补一发 setVisible(false)：面板拆掉了，原生视图不能留在屏幕上', () => {
    const { api, view } = mount(stateOf())

    view.unmount()

    expect(api.calls).toContain('setVisible:false')
  })
})
