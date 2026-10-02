/*
 * 宿主侧的自检。WebContentsView 要一个真的 Chromium 才活得起来，所以这里先给 'electron'
 * 装一个假实现再动态 import 宿主：假视图记下 setBounds/setVisible 的每一次调用，
 * webContents 的 on 也真的把回调存起来 —— 「谁可见、摆在哪儿、关掉之后落到哪一页」
 * 本来就与内核无关。
 */

import { beforeEach, describe, expect, mock, test } from 'bun:test'
import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { Rectangle } from 'electron'

import type { BrowserElementPicked, BrowserState } from './host'

type Listener = (...args: readonly unknown[]) => void

interface FakeContents {
  readonly listeners: Map<string, Listener[]>
  readonly openHandler: { current: ((details: { url: string }) => { action: string }) | null }
  readonly injected: string[]
  readonly loaded: string[]
  readonly closed: { count: number }
  on(event: string, listener: Listener): void
  emit(event: string, ...args: readonly unknown[]): void
  setWindowOpenHandler(handler: (details: { url: string }) => { action: string }): void
  loadURL(url: string): Promise<void>
  close(): void
  reload(): void
  print(options: unknown, callback: (success: boolean, reason: string) => void): void
  executeJavaScriptInIsolatedWorld(world: number, scripts: { code: string }[]): Promise<void>
  readonly navigationHistory: {
    canGoBack(): boolean
    canGoForward(): boolean
    goBack(): void
    goForward(): void
    back: { count: number }
    forward: { count: number }
  }
}

interface FakeView {
  readonly visible: boolean[]
  readonly bounds: Rectangle[]
  readonly webContents: FakeContents
  setVisible(next: boolean): void
  setBounds(next: Rectangle): void
}

function fakeContents(): FakeContents {
  const listeners = new Map<string, Listener[]>()
  const injected: string[] = []
  const loaded: string[] = []
  const closed = { count: 0 }
  const back = { count: 0 }
  const forward = { count: 0 }

  return {
    listeners,
    openHandler: { current: null },
    injected,
    loaded,
    closed,
    on(event, listener) {
      listeners.set(event, [...(listeners.get(event) ?? []), listener])
    },
    emit(event, ...args) {
      for (const listener of listeners.get(event) ?? []) {
        listener(...args)
      }
    },
    setWindowOpenHandler(handler) {
      this.openHandler.current = handler
    },
    loadURL(url) {
      loaded.push(url)

      return Promise.resolve()
    },
    close() {
      closed.count += 1
    },
    reload() {},
    print(_options, callback) {
      callback(true, '')
    },
    executeJavaScriptInIsolatedWorld(_world, scripts) {
      injected.push(...scripts.map((script) => script.code))

      return Promise.resolve()
    },
    navigationHistory: {
      // 内核的导航历史是「能不能退」在前、「退」在后：桩照这个顺序记账，退到头就不再执行。
      canGoBack: () => back.count === 0,
      canGoForward: () => forward.count === 0,
      goBack: () => {
        back.count += 1
      },
      goForward: () => {
        forward.count += 1
      },
      back,
      forward,
    },
  }
}

class FakeWebContentsView implements FakeView {
  readonly visible: boolean[] = []
  readonly bounds: Rectangle[] = []
  readonly webContents = fakeContents()

  setVisible(next: boolean): void {
    this.visible.push(next)
  }

  setBounds(next: Rectangle): void {
    this.bounds.push(next)
  }
}

const created: FakeWebContentsView[] = []

mock.module('electron', () => ({
  WebContentsView: class extends FakeWebContentsView {
    constructor() {
      super()

      created.push(this)
    }
  },
}))

// 注入脚本的正文由构建期产出，自检不去跑一遍构建：给一份最小的替身，只要 start/cancel 两个入口在。
process.env['POIETICA_PICKER_SCRIPT'] = join(tmpdir(), 'poietica-picker-stub.js')

writeFileSync(
  process.env['POIETICA_PICKER_SCRIPT'],
  'window.__poieticaElementPicker = { start() {}, cancel() {} };',
  'utf8',
)

const { applyBrowserCommand, createBrowserHost } = await import('./host')

interface Harness {
  readonly host: ReturnType<typeof createBrowserHost>
  readonly states: BrowserState[]
  readonly picked: BrowserElementPicked[]
}

function harness(): Harness {
  const states: BrowserState[] = []
  const picked: BrowserElementPicked[] = []

  const win = {
    contentView: {
      addChildView: () => undefined,
      removeChildView: () => undefined,
    },
  } as unknown as Parameters<typeof createBrowserHost>[0]

  const host = createBrowserHost(
    win,
    (state) => {
      states.push(state)
    },
    {
      onElementPicked: (element) => {
        picked.push(element)
      },
    },
  )

  return { host, states, picked }
}

const lastView = (): FakeWebContentsView => created[created.length - 1] as FakeWebContentsView
const visibleViews = (): FakeWebContentsView[] =>
  created.filter((view) => view.visible.at(-1) === true)

beforeEach(() => {
  created.length = 0
})

describe('摆放', () => {
  test('开三个标签：只有活动的可见，矩形等于最后一次上报', () => {
    const { host } = harness()

    host.setBounds({ x: 10, y: 20, width: 300, height: 200 })
    host.setVisible(true)

    host.openTab('https://a.example/')
    host.openTab('https://b.example/')
    host.openTab('https://c.example/')

    expect(created).toHaveLength(3)
    expect(visibleViews()).toHaveLength(1)
    expect(visibleViews()[0]).toBe(lastView())
    expect(lastView().bounds.at(-1)).toEqual({ x: 10, y: 20, width: 300, height: 200 })
    expect(host.state().activeTabId).toBe(2)
  })

  test('收起面板：一个都不画', () => {
    const { host } = harness()

    host.setVisible(true)
    host.openTab('https://a.example/')
    host.setVisible(false)

    expect(visibleViews()).toHaveLength(0)
    expect(created[0]?.visible.at(-1)).toBe(false)
  })

  test('窗口 resize 后按最后一次上报的矩形重摆', () => {
    const { host } = harness()

    host.setBounds({ x: 1, y: 2, width: 100, height: 100 })
    host.setVisible(true)
    host.openTab('https://a.example/')

    host.relayout()

    expect(created[0]?.bounds.at(-1)).toEqual({ x: 1, y: 2, width: 100, height: 100 })

    host.setBounds({ x: 5, y: 6, width: 640, height: 480 })

    expect(created[0]?.bounds.at(-1)).toEqual({ x: 5, y: 6, width: 640, height: 480 })
  })

  test('零尺寸抬到 1 像素：内核不接受零尺寸', () => {
    const { host } = harness()

    host.setBounds({ x: 0, y: 0, width: 0, height: 0 })
    host.setVisible(true)
    host.openTab('https://a.example/')

    expect(created[0]?.bounds.at(-1)).toEqual({ x: 0, y: 0, width: 1, height: 1 })
  })

  test('空白标签没有 url，也不占面板', () => {
    const { host } = harness()

    host.setVisible(true)
    host.openTab('https://a.example/')
    host.openTab(null)

    expect(host.state().tabs[1]?.url).toBeNull()
    expect(visibleViews()).toHaveLength(0)
  })

  /*
   * 面板拖动是每帧一次的通报（packages/browser/src/viewport-alignment.ts），
   * 逐帧把同一个可见性重复下发给每个标签是白付的：实测 5 个标签 60 帧 = 300 次。
   * 这里钉住「没翻转就不叫内核」，同时钉住真的翻转时一次都没漏。
   */
  test('可见性没翻转就不叫内核；翻转了就照旧下发', () => {
    const { host } = harness()

    host.setVisible(true)
    host.openTab('https://a.example/')

    const only = created[0] as FakeWebContentsView

    // 建视图时先隐一次，挂上来由 layout 亮一次 —— 这就是开一个标签的两笔账。
    expect(only.visible).toEqual([false, true])

    // 拖动：可见性自始至终没变，内核不该再被叫。
    for (let frame = 0; frame < 60; frame += 1) {
      host.setBounds({ x: frame, y: 0, width: 300, height: 200 })
    }

    expect(only.visible).toEqual([false, true])

    // 翻转两次就下发两次：省的是重复，不是真变化。
    host.setVisible(false)
    host.setVisible(true)

    expect(only.visible).toEqual([false, true, false, true])
  })
})

describe('关标签与最近关闭', () => {
  test('关掉活动标签：焦点落到右边那一页', () => {
    const { host } = harness()

    host.openTab('https://a.example/')
    host.openTab('https://b.example/')
    host.openTab('https://c.example/')
    host.selectTab(1)
    host.closeTab(1)

    expect(host.state().activeTabId).toBe(2)
  })

  test('关掉最右一页：焦点落到左边那一页', () => {
    const { host } = harness()

    host.openTab('https://a.example/')
    host.openTab('https://b.example/')
    host.closeTab(1)

    expect(host.state().activeTabId).toBe(0)
  })

  test('最近关闭按 LIFO 排队，空白页不进环', () => {
    const { host } = harness()

    host.openTab('https://a.example/')
    host.openTab('https://b.example/')
    host.openTab(null)
    host.closeTab(0)
    host.closeTab(2)
    host.closeTab(1)

    expect(host.state().recentlyClosed.map((closed) => closed.url)).toEqual([
      'https://b.example/',
      'https://a.example/',
    ])
  })

  test('环最多留十格：更早的关掉记录会被挤出去', () => {
    const { host } = harness()

    for (let index = 0; index < 12; index += 1) {
      host.openTab(`https://site-${index}.example/`)
    }

    for (let index = 0; index < 12; index += 1) {
      host.closeTab(index)
    }

    const urls = host.state().recentlyClosed.map((closed) => closed.url)

    expect(urls).toHaveLength(10)
    expect(urls[0]).toBe('https://site-11.example/')
    expect(urls.at(-1)).toBe('https://site-2.example/')
  })

  test('重开取走环里那一格，开的是一张新标签并设为活动', () => {
    const { host } = harness()

    host.openTab('https://a.example/')
    host.closeTab(0)
    host.reopenClosed(0)

    const state = host.state()

    // 旧标签已经关掉了，「重开」只能是新开一张：id 不复用，环里那一格被取走。
    expect(state.tabs).toHaveLength(1)
    expect(state.tabs[0]?.id).toBe(1)
    expect(state.tabs[0]?.url).toBe('https://a.example/')
    expect(state.activeTabId).toBe(1)
    expect(state.recentlyClosed).toHaveLength(0)
  })
})

describe('状态与导航', () => {
  test('状态的形状与 packages/contract/src/browser.ts 一致', () => {
    const { host } = harness()

    host.openTab('https://a.example/')

    expect(Object.keys(host.state()).sort()).toEqual(
      ['activeTabId', 'pickingTabId', 'recentlyClosed', 'revision', 'tabs'].sort(),
    )
    expect(Object.keys(host.state().tabs[0] ?? {}).sort()).toEqual(
      ['favicon', 'id', 'loading', 'title', 'url'].sort(),
    )
  })

  test('裸主机名补 https，本地地址走 http，搜索词被拒', () => {
    const { host } = harness()

    host.openTab('example.com')
    host.openTab('localhost:5173')
    // 搜索词不是地址：被拒的这一次根本不建标签，与 browser_open_tab 返回错误一致。
    host.openTab('两个 词')

    expect(host.state().tabs).toHaveLength(2)
    expect(host.state().tabs.map((tab) => tab.url)).toEqual([
      'https://example.com/',
      'http://localhost:5173/',
    ])
  })

  test('本地文件放行，不支持的 scheme 原地不动', () => {
    const { host } = harness()

    host.openTab('https://a.example/')
    // file: 是「用户自己机器上的东西」，crates/browser 的 normalize_address 也放行它。
    host.navigate(0, 'file:///C:/tmp/report.html')
    expect(host.state().tabs[0]?.url).toBe('file:///C:/tmp/report.html')

    host.navigate(0, 'ftp://example.com/')
    expect(host.state().tabs[0]?.url).toBe('file:///C:/tmp/report.html')
  })

  test('页面标题进标签，空标题不改', () => {
    const { host } = harness()

    host.openTab('https://a.example/')
    lastView().webContents.emit('page-title-updated', {}, 'A 站')
    expect(host.state().tabs[0]?.title).toBe('A 站')

    lastView().webContents.emit('page-title-updated', {}, '')
    expect(host.state().tabs[0]?.title).toBe('A 站')
  })

  test('装载事件改 loading，同向重复事件不再发一次状态', () => {
    const { host, states } = harness()

    host.openTab('https://a.example/')

    const before = states.length

    lastView().webContents.emit('did-start-loading')
    lastView().webContents.emit('did-start-loading')

    expect(states.length).toBe(before)
    expect(host.state().tabs[0]?.loading).toBe(true)

    lastView().webContents.emit('did-stop-loading')
    expect(host.state().tabs[0]?.loading).toBe(false)
  })

  test('导航到 about:blank 回到「没有 url」', () => {
    const { host } = harness()

    host.openTab('https://a.example/')
    lastView().webContents.emit('did-navigate', {}, 'about:blank')

    expect(host.state().tabs[0]?.url).toBeNull()
  })

  test('弹窗一律拒：http(s) 的目标改成宿主开一个新标签', () => {
    const { host } = harness()

    host.openTab('https://a.example/')

    const handler = lastView().webContents.openHandler.current

    expect(handler?.({ url: 'https://b.example/' })).toEqual({ action: 'deny' })
    expect(host.state().tabs).toHaveLength(2)
    expect(lastView().webContents.loaded.at(-1)).toBe('https://b.example/')

    expect(handler?.({ url: 'file:///etc/passwd' })).toEqual({ action: 'deny' })
    expect(host.state().tabs).toHaveLength(2)
  })
})

describe('元素拾取', () => {
  test('启用时先注入脚本再下 start，pickingTabId 跟着走', () => {
    const { host } = harness()

    host.openTab('https://a.example/')
    host.setElementPicker(0, true, 'dark')

    const injected = lastView().webContents.injected

    // 先注入脚本本身，再下这一轮的 start：顺序反了页面里还没有那个对象。
    expect(injected).toHaveLength(2)
    expect(injected[0]).toContain('__poieticaElementPicker')
    expect(injected[1]).toContain("window.__poieticaElementPicker.start(1,'dark')")
    expect(host.state().pickingTabId).toBe(0)
  })

  test('换标签拾取会退掉上一个面板', () => {
    const { host } = harness()

    host.openTab('https://a.example/')
    host.openTab('https://b.example/')

    const first = created[0] as FakeWebContentsView

    host.setElementPicker(0, true, 'light')
    host.setElementPicker(1, true, 'light')

    expect(first.webContents.injected).toContain('window.__poieticaElementPicker?.cancel();')
    expect(host.state().pickingTabId).toBe(1)
  })

  test('回调带对 token 才算数，过期的载荷被丢掉', async () => {
    const { host, picked } = harness()

    host.openTab('https://a.example/')
    host.setElementPicker(0, true, 'light')

    const callback = (query: string): void => {
      lastView().webContents.emit(
        'will-navigate',
        { preventDefault: () => undefined },
        `https://pick.poietica.invalid/?${query}`,
      )
    }

    callback('token=99&submission=cancel')
    expect(host.state().pickingTabId).toBe(0)

    callback('token=1&submission=send&elementType=button&report=%E5%AD%97%E5%8F%B7')
    expect(host.state().pickingTabId).toBeNull()
    expect(picked).toHaveLength(1)
    expect(picked[0]?.elementType).toBe('button')
    expect(picked[0]?.submission).toBe('send')
  })

  test('收起面板时停掉拾取', () => {
    const { host } = harness()

    host.openTab('https://a.example/')
    host.setElementPicker(0, true, 'light')
    host.setVisible(false)

    expect(host.state().pickingTabId).toBeNull()
  })
})

describe('命令面', () => {
  test('认得的命令自己答，认不得的交回主进程', () => {
    const { host } = harness()

    expect(applyBrowserCommand(host, 'browser_state', {}).handled).toBe(true)
    expect(applyBrowserCommand(host, 'agent_threads', {}).handled).toBe(false)
    expect(
      applyBrowserCommand(host, 'browser_set_element_picker', { id: 3, enabled: true }).handled,
    ).toBe(true)
  })

  test('set_bounds / set_visible / open_tab 都落在宿主上', () => {
    const { host } = harness()

    applyBrowserCommand(host, 'browser_set_bounds', { x: 7, y: 8, width: 9, height: 10 })
    applyBrowserCommand(host, 'browser_set_visible', { visible: true })
    applyBrowserCommand(host, 'browser_open_tab', { url: 'https://a.example/' })

    expect(lastView().bounds.at(-1)).toEqual({ x: 7, y: 8, width: 9, height: 10 })
    expect(lastView().visible.at(-1)).toBe(true)
  })

  test('back/forward 走内核的导航历史，不是页面里的 history.back()', () => {
    const { host } = harness()

    host.openTab('https://a.example/')

    const history = lastView().webContents.navigationHistory

    // 退过一次之后 canGoBack 已经为假，第二次 back 不该再落到内核上。
    host.back(0)
    host.back(0)
    host.forward(0)

    expect(history.back.count).toBe(1)
    expect(history.forward.count).toBe(1)
  })
})
