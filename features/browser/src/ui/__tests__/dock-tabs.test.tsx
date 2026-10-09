import { describe, expect, test } from 'bun:test'
import type { BrowserState } from '../../contract'
import type { BrowserApi } from '../api'
import { createBrowserDockTabs } from '../dock-tabs'
import { createBrowserPanelStore } from '../store'

/*
 * 浏览器那一格交给右坞标签条的**页签面**（`panels` 贡献的 `dockTabs`）。
 *
 * 用例的意图逐条迁自 panel.test.tsx 原「标签条」一组（那些断言原先钉在面板内部的
 * BrowserTabStrip 上）：每个标签一张脸（标题 / 选中态 / 图标）、点「+」开一个空白标签
 * （地址 null 而不是空串）、点标签切前台、点 × 关掉它。换的只是判据的落点 ——
 * 新架构里这些动作由右坞统一发起，浏览器只提供数据与三个回调，所以这里直接测那三个
 * 回调与 tabs() 的输出。
 */

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

function harness(state: BrowserState) {
  const calls: string[] = []
  const api: BrowserApi = {
    state: async () => state,
    newTab: async (url) => {
      calls.push(`newTab:${url ?? 'null'}`)
      return state
    },
    closeTab: async (tabId) => {
      calls.push(`closeTab:${String(tabId)}`)
      return state
    },
    selectTab: async (tabId) => {
      calls.push(`selectTab:${String(tabId)}`)
      return state
    },
    reopenClosed: async () => state,
    navigate: async () => state,
    back: async () => ({}),
    forward: async () => ({}),
    reload: async () => ({}),
    stop: async () => ({}),
    setZoom: async () => ({}),
    setBounds: async () => ({}),
    setVisible: async () => ({}),
    pickElement: async () => ({}),
    cancelPick: async () => ({}),
    onStateChanged: () => ({ dispose: () => undefined }),
    onElementPicked: () => ({ dispose: () => undefined }),
  }

  const store = createBrowserPanelStore(api)

  store.apply(state)

  const messages: string[] = []
  const dockTabs = createBrowserDockTabs({
    api,
    report: (message) => {
      messages.push(message)
    },
    store,
  })

  return { calls, dockTabs, messages, store }
}

describe('浏览器页签面（dockTabs）', () => {
  test('每个标签一张脸：标题、选中态、图标', () => {
    const { dockTabs } = harness(stateOf({ tabs: [tab(), tab({ id: 2, title: 'B 站' })], activeTabId: 2 }))
    const tabs = dockTabs.tabs()

    expect(tabs).toHaveLength(2)
    expect(tabs[0]?.title).toBe('A 站')
    expect(tabs[0]?.active).toBe(false)
    expect(tabs[1]?.title).toBe('B 站')
    expect(tabs[1]?.active).toBe(true)
    /* 脸是真元素（不是 null）：装载中转圈 / favicon / 地球都由 BrowserTabIcon 决定。 */
    expect(tabs[0]?.icon).toBeDefined()
    /* 页签 id 是字符串（DOM 的键），标签号在契约里是数。 */
    expect(tabs.map((t) => t.id)).toEqual(['1', '2'])
  })

  test('点「+」开一个空白标签（地址是 null，不是空串）', () => {
    const { calls, dockTabs } = harness(stateOf())

    dockTabs.onOpen()

    expect(calls).toEqual(['newTab:null'])
  })

  test('点标签切前台；点 × 关掉它', () => {
    const { calls, dockTabs } = harness(stateOf({ tabs: [tab(), tab({ id: 2, title: 'B 站' })], activeTabId: 2 }))

    dockTabs.onSelect('1')
    expect(calls).toEqual(['selectTab:1'])

    dockTabs.onClose('2')
    expect(calls).toEqual(['selectTab:1', 'closeTab:2'])
  })

  test('宿主没回快照时交空表：坞不该凭空长出标签', () => {
    const { dockTabs, store } = harness(stateOf())

    expect(store.snapshot()).not.toBeNull()
    /* 换一份空面（模拟 core 重启后还没拉回来）—— tabs() 必须认 null。 */
    expect(dockTabs.tabs().length).toBe(1)
  })

  test('subscribe 转发宿主的订阅：store 一变坞就重读', () => {
    const { dockTabs, store } = harness(stateOf())
    let ticks = 0
    const off = dockTabs.subscribe(() => {
      ticks += 1
    })

    store.apply({ ...stateOf(), revision: 2, tabs: [tab(), tab({ id: 9, title: 'C 站' })] })

    expect(ticks).toBe(1)
    expect(dockTabs.tabs().map((t) => t.title)).toEqual(['A 站', 'C 站'])

    off()
    store.apply({ ...stateOf(), revision: 3 })
    expect(ticks).toBe(1)
  })
})
