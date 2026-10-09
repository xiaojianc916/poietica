import { beforeEach, describe, expect, test } from 'bun:test'
import { createTestLogger, type FakeClock, fakeClock } from '@poietica/test-kit'
import type { BrowserState } from '../../contract'
import {
  type BrowserTabs,
  type ContentsListener,
  createBrowserTabs,
  type RectangleLike,
  type ViewHost,
  type WebContentsLike,
  type WebContentsViewLike,
} from '../tabs'

/*
 * 标签与视图的自检。真 Chromium 不参与：ViewHost 是注入面，假视图记下 setBounds/setVisible
 * 的每一次调用、webContents 的 on 真的把回调存起来 —— 「谁可见、摆在哪儿、关掉之后落到
 * 哪一页」本来就与内核无关（这一组断言**迁移自** legacy host.test.ts 的对应几组）。
 *
 * 时间也注入：16ms 合批要能被确定地推进（fakeClock.advance(16)），否则断言只能靠等。
 */

type Listener = (...args: readonly unknown[]) => void

interface FakeContents extends WebContentsLike {
  readonly listeners: Map<string, ContentsListener[]>
  readonly injected: string[]
  readonly loaded: string[]
  readonly closed: { count: number }
  readonly zoom: { mode: 'isolated' | 'proportional' | null; level: number }
  readonly openHandler: { current: ((details: { url: string }) => { action: 'deny' | 'allow' }) | null }
  emit(event: string, ...args: readonly unknown[]): void
}

interface FakeView extends WebContentsViewLike {
  readonly visible: boolean[]
  readonly bounds: RectangleLike[]
  readonly webContents: FakeContents
}

function fakeContents(): FakeContents {
  const listeners = new Map<string, ContentsListener[]>()
  const injected: string[] = []
  const loaded: string[] = []
  const closed = { count: 0 }
  const back = { count: 0 }
  const forward = { count: 0 }
  /* 缩放归内核：这里照内核的三种调用记一份，好让「一格一档」可被断言。 */
  const zoom = { mode: null as 'isolated' | 'proportional' | null, level: 0 }
  let url = ''
  let loading = false
  let attached = false

  const contents: FakeContents = {
    listeners,
    injected,
    loaded,
    closed,
    zoom,
    openHandler: { current: null },
    emit(event, ...args) {
      for (const listener of listeners.get(event) ?? []) {
        ;(listener as Listener)(...args)
      }
    },
    getURL: () => url,
    isLoading: () => loading,
    loadURL(next) {
      loaded.push(next)
      url = next
      loading = true

      return Promise.resolve()
    },
    close() {
      closed.count += 1
    },
    reload() {},
    stop() {},
    setZoomLevel(level) {
      zoom.level = level
    },
    getZoomLevel: () => zoom.level,
    setZoomMode(mode) {
      zoom.mode = mode
    },
    executeJavaScriptInIsolatedWorld(_world, scripts) {
      injected.push(...scripts.map((script) => script.code))

      return Promise.resolve(undefined)
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
    },
    setWindowOpenHandler(handler) {
      contents.openHandler.current = handler
    },
    on(event, listener) {
      listeners.set(event, [...(listeners.get(event) ?? []), listener])
    },
    debugger: {
      isAttached: () => attached,
      attach: () => {
        attached = true
      },
      detach: () => {
        attached = false
      },
      sendCommand: (method) => Promise.resolve({ method }),
      on(event, listener) {
        listeners.set(`debugger:${event}`, [...(listeners.get(`debugger:${event}`) ?? []), listener])
      },
    },
  }

  return contents
}

class FakeWebContentsView implements FakeView {
  readonly visible: boolean[] = []
  readonly bounds: RectangleLike[] = []
  readonly webContents = fakeContents()

  setVisible(next: boolean): void {
    this.visible.push(next)
  }

  setBounds(next: RectangleLike): void {
    this.bounds.push(next)
  }
}

interface Harness {
  readonly tabs: BrowserTabs
  readonly created: FakeWebContentsView[]
  readonly attached: FakeWebContentsView[]
  readonly clock: FakeClock
  readonly states: BrowserState[]
  readonly picked: string[]
  readonly resize: { run(): void }
}

function harness(): Harness {
  const created: FakeWebContentsView[] = []
  const attached: FakeWebContentsView[] = []
  const states: BrowserState[] = []
  const picked: string[] = []
  const clock = fakeClock()
  const resizeListeners: (() => void)[] = []

  const host: ViewHost = {
    createView() {
      const view = new FakeWebContentsView()

      created.push(view)

      return view
    },
    attach(view) {
      attached.push(view as FakeWebContentsView)
    },
    detach() {},
    zoomFactor: () => 1,
    onResize(fn) {
      resizeListeners.push(fn)

      return {
        dispose: () => {
          const index = resizeListeners.indexOf(fn)

          if (index >= 0) {
            resizeListeners.splice(index, 1)
          }
        },
      }
    },
  }

  const tabs = createBrowserTabs(host, {
    logger: createTestLogger(),
    clock,
    onPickerCallback: (_tabId, url) => {
      picked.push(url)
    },
  })

  tabs.onState((state) => {
    states.push(state)
  })

  return {
    tabs,
    created,
    attached,
    clock,
    states,
    picked,
    resize: {
      run: () => {
        for (const fn of [...resizeListeners]) {
          fn()
        }
      },
    },
  }
}

const lastView = (h: Harness): FakeWebContentsView => h.created[h.created.length - 1] as FakeWebContentsView
const visibleViews = (h: Harness): FakeWebContentsView[] => h.created.filter((view) => view.visible.at(-1) === true)

let h: Harness

beforeEach(() => {
  h = harness()
})

describe('摆放与可见性（迁移自 legacy host.test.ts）', () => {
  test('开三个标签：只有活动的可见，矩形等于最后一次上报', () => {
    h.tabs.setBounds({ x: 10, y: 20, width: 300, height: 200 })
    h.tabs.setVisible(true)
    h.tabs.openTab('https://a.example/')
    h.tabs.openTab('https://b.example/')
    h.tabs.openTab('https://c.example/')

    expect(h.created).toHaveLength(3)
    expect(visibleViews(h)).toHaveLength(1)
    expect(visibleViews(h)[0]).toBe(lastView(h))
    expect(lastView(h).bounds.at(-1)).toEqual({ x: 10, y: 20, width: 300, height: 200 })
    expect(h.tabs.state().activeTabId).toBe(3)
  })

  test('收起面板：一个都不画', () => {
    h.tabs.setVisible(true)
    h.tabs.openTab('https://a.example/')
    h.tabs.setVisible(false)

    expect(visibleViews(h)).toHaveLength(0)
    expect(h.created[0]?.visible.at(-1)).toBe(false)
  })

  test('窗口 resize 后按最后一次上报的矩形重摆', () => {
    h.tabs.setBounds({ x: 1, y: 2, width: 100, height: 100 })
    h.tabs.setVisible(true)
    h.tabs.openTab('https://a.example/')

    h.resize.run()

    expect(h.created[0]?.bounds.at(-1)).toEqual({ x: 1, y: 2, width: 100, height: 100 })

    h.tabs.setBounds({ x: 5, y: 6, width: 640, height: 480 })

    expect(h.created[0]?.bounds.at(-1)).toEqual({ x: 5, y: 6, width: 640, height: 480 })
  })

  test('零尺寸抬到 1 像素：内核不接受零尺寸', () => {
    h.tabs.setBounds({ x: 0, y: 0, width: 0, height: 0 })
    h.tabs.setVisible(true)
    h.tabs.openTab('https://a.example/')

    expect(h.created[0]?.bounds.at(-1)).toEqual({ x: 0, y: 0, width: 1, height: 1 })
  })

  test('空白标签没有 url，也不占面板', () => {
    h.tabs.setVisible(true)
    h.tabs.openTab('https://a.example/')
    h.tabs.openTab(null)

    expect(h.tabs.state().tabs[1]?.url).toBeNull()
    expect(visibleViews(h)).toHaveLength(0)
  })

  /*
   * agent 经 CDP 导航（relay 那条线）不经过宿主的命令面：地址由内核报回来的 did-navigate
   * 落账。那张标签在导航前是空白的，不占面板；落账之后必须当场被摆上 —— 只 publish 不
   * layout 的写法会让画面停在隐藏状态：地址、标题都对，就是没内容。
   */
  test('CDP 导航落账：空白标签当场摆上；退回空白页再收走', () => {
    h.tabs.setBounds({ x: 10, y: 20, width: 300, height: 200 })
    h.tabs.setVisible(true)
    h.tabs.openTab(null)

    const only = h.created[0] as FakeWebContentsView

    expect(visibleViews(h)).toHaveLength(0)

    only.webContents.emit('did-navigate', {}, 'https://a.example/')

    expect(h.tabs.state().tabs[0]?.url).toBe('https://a.example/')
    expect(visibleViews(h)).toHaveLength(1)
    expect(only.bounds.at(-1)).toEqual({ x: 10, y: 20, width: 300, height: 200 })

    only.webContents.emit('did-navigate', {}, 'about:blank')

    expect(h.tabs.state().tabs[0]?.url).toBeNull()
    expect(visibleViews(h)).toHaveLength(0)
  })

  /*
   * 面板拖动是每帧一次的通报（viewport.ts），逐帧把同一个可见性重复下发给每个标签是白付的：
   * 实测 5 个标签 60 帧 = 300 次。这里钉住「没翻转就不叫内核」，同时钉住真的翻转时一次都没漏。
   */
  test('可见性没翻转就不叫内核；翻转了就照旧下发', () => {
    h.tabs.setVisible(true)
    h.tabs.openTab('https://a.example/')

    const only = h.created[0] as FakeWebContentsView

    // 建视图时先隐一次，挂上来由 layout 亮一次 —— 这就是开一个标签的两笔账。
    expect(only.visible).toEqual([false, true])

    for (let frame = 0; frame < 60; frame += 1) {
      h.tabs.setBounds({ x: frame, y: 0, width: 300, height: 200 })
    }

    expect(only.visible).toEqual([false, true])

    h.tabs.setVisible(false)
    h.tabs.setVisible(true)

    expect(only.visible).toEqual([false, true, false, true])
  })

  test('缩放因子进矩形换算（CSS 像素 × zoomFactor）', () => {
    let factor = 1.25
    const created: FakeWebContentsView[] = []
    const tabs = createBrowserTabs(
      {
        createView: () => {
          const view = new FakeWebContentsView()

          created.push(view)

          return view
        },
        attach: () => undefined,
        detach: () => undefined,
        zoomFactor: () => factor,
        onResize: () => ({ dispose: () => undefined }),
      },
      { logger: createTestLogger(), clock: fakeClock(), onPickerCallback: () => undefined },
    )

    tabs.setVisible(true)
    tabs.setBounds({ x: 10, y: 20, width: 300, height: 200 })
    tabs.openTab('https://a.example/')

    expect(created[0]?.bounds.at(-1)).toEqual({ x: 13, y: 25, width: 375, height: 250 })

    factor = 1
    tabs.setBounds({ x: 10, y: 20, width: 300, height: 200 })

    expect(created[0]?.bounds.at(-1)).toEqual({ x: 10, y: 20, width: 300, height: 200 })
  })
})

describe('BR-10: 关标签与最近关闭', () => {
  test('关掉活动标签：焦点落到右边那一页', () => {
    h.tabs.openTab('https://a.example/')
    h.tabs.openTab('https://b.example/')
    h.tabs.openTab('https://c.example/')
    h.tabs.selectTab(2)
    h.tabs.closeTab(2)

    expect(h.tabs.state().activeTabId).toBe(3)
  })

  test('关掉最右一页：焦点落到左边那一页', () => {
    h.tabs.openTab('https://a.example/')
    h.tabs.openTab('https://b.example/')
    h.tabs.closeTab(2)

    expect(h.tabs.state().activeTabId).toBe(1)
  })

  test('最近关闭按 LIFO 排队，空白页不进环', () => {
    h.tabs.openTab('https://a.example/')
    h.tabs.openTab('https://b.example/')
    h.tabs.openTab(null)
    h.tabs.closeTab(1)
    h.tabs.closeTab(3)
    h.tabs.closeTab(2)

    expect(h.tabs.state().recentlyClosed.map((closed) => closed.url)).toEqual([
      'https://b.example/',
      'https://a.example/',
    ])
  })

  test('环最多留十格：更早的关掉记录会被挤出去', () => {
    for (let index = 0; index < 12; index += 1) {
      h.tabs.openTab(`https://site-${String(index)}.example/`)
    }

    for (let index = 1; index <= 12; index += 1) {
      h.tabs.closeTab(index)
    }

    const urls = h.tabs.state().recentlyClosed.map((closed) => closed.url)

    expect(urls).toHaveLength(10)
    expect(urls[0]).toBe('https://site-11.example/')
    expect(urls.at(-1)).toBe('https://site-2.example/')
  })

  test('重开取走环里那一格，开的是一张新标签并设为活动', () => {
    h.tabs.openTab('https://a.example/')
    h.tabs.closeTab(1)
    h.tabs.reopenClosed(0)

    const state = h.tabs.state()

    // 旧标签已经关掉了，「重开」只能是新开一张：id 不复用，环里那一格被取走。
    expect(state.tabs).toHaveLength(1)
    expect(state.tabs[0]?.id).toBe(2)
    expect(state.tabs[0]?.url).toBe('https://a.example/')
    expect(state.activeTabId).toBe(2)
    expect(state.recentlyClosed).toHaveLength(0)
  })

  test('关标签时视图被摘掉并关掉内核对象', () => {
    h.tabs.openTab('https://a.example/')
    const only = h.created[0] as FakeWebContentsView

    h.tabs.closeTab(1)

    expect(only.webContents.closed.count).toBe(1)
    expect(h.tabs.state().tabs).toHaveLength(0)
    expect(h.tabs.state().activeTabId).toBeNull()
  })
})

describe('状态形状与合批', () => {
  test('状态的形状与 07 页 §12B 的实体一致', () => {
    h.tabs.openTab('https://a.example/')

    expect(Object.keys(h.tabs.state()).sort()).toEqual(
      ['activeTabId', 'driven', 'pickingTabId', 'recentlyClosed', 'revision', 'tabs'].sort(),
    )
    expect(Object.keys(h.tabs.state().tabs[0] ?? {}).sort()).toEqual(
      ['canGoBack', 'canGoForward', 'favicon', 'id', 'loading', 'title', 'url', 'zoom'].sort(),
    )
  })

  test('变化按 16ms 合批，同向重复事件不再发一次状态', () => {
    h.tabs.openTab('https://a.example/')

    // onState 是 16ms 合批的：开标签这一笔要推进时钟才送出来。
    expect(h.states).toHaveLength(0)
    h.clock.advance(16)
    expect(h.states).toHaveLength(1)

    const before = h.states.length
    const only = lastView(h)

    // openTab 已经把它记成装载中：两次同向的 did-start-loading 都不是变化。
    only.webContents.emit('did-start-loading')
    only.webContents.emit('did-start-loading')
    h.clock.advance(16)

    expect(h.states.length).toBe(before)
    expect(h.tabs.state().tabs[0]?.loading).toBe(true)

    // 反向那一次才是变化：批里照样只有最后一帧被送出。
    only.webContents.emit('did-stop-loading')
    h.clock.advance(16)

    expect(h.states.length).toBe(before + 1)
    expect(h.tabs.state().tabs[0]?.loading).toBe(false)
  })

  test('一批里多次变化只送最后一次，revision 单调递增', () => {
    h.tabs.openTab('https://a.example/')
    h.tabs.openTab('https://b.example/')
    h.tabs.selectTab(1)
    h.clock.advance(16)

    expect(h.states).toHaveLength(1)
    expect(h.states[0]?.tabs).toHaveLength(2)
    expect(h.states[0]?.activeTabId).toBe(1)
    expect(h.states[0]?.revision).toBeGreaterThan(1)

    h.tabs.setDriven(true)
    h.clock.advance(16)

    expect(h.states[1]?.revision).toBeGreaterThan(h.states[0]?.revision ?? 0)
    expect(h.states[1]?.driven).toBe(true)
  })
})

describe('导航与事件', () => {
  test('裸主机名补 https，本地地址走 http，搜索词被拒', () => {
    expect(h.tabs.openTab('example.com')).toBe(1)
    expect(h.tabs.openTab('localhost:5173')).toBe(2)
    // 搜索词不是地址：被拒的这一次根本不建标签（与 legacy 的 host 同一条）。
    expect(h.tabs.openTab('两个 词')).toBeNull()

    expect(h.tabs.state().tabs).toHaveLength(2)
    expect(h.tabs.state().tabs.map((tab) => tab.url)).toEqual(['https://example.com/', 'http://localhost:5173/'])
  })

  test('本地文件放行，不支持的 scheme 抛 browser.invalid_url', () => {
    h.tabs.openTab('https://a.example/')
    h.tabs.navigate(1, 'file:///C:/tmp/report.html')

    expect(h.tabs.state().tabs[0]?.url).toBe('file:///C:/tmp/report.html')

    expect(() => {
      h.tabs.navigate(1, 'ftp://example.com/')
    }).toThrow()
  })

  test('不存在的标签一律 browser.tab_not_found', () => {
    expect(() => {
      h.tabs.closeTab(9)
    }).toThrow()
    expect(() => {
      h.tabs.selectTab(9)
    }).toThrow()
    expect(() => {
      h.tabs.reload(9)
    }).toThrow()
  })

  test('页面标题进标签，空标题不改', () => {
    h.tabs.openTab('https://a.example/')
    lastView(h).webContents.emit('page-title-updated', {}, 'A 站')

    expect(h.tabs.state().tabs[0]?.title).toBe('A 站')

    lastView(h).webContents.emit('page-title-updated', {}, '')

    expect(h.tabs.state().tabs[0]?.title).toBe('A 站')
  })

  test('favicon 进标签', () => {
    h.tabs.openTab('https://a.example/')
    lastView(h).webContents.emit('page-favicon-updated', {}, ['https://a.example/favicon.ico'])

    expect(h.tabs.state().tabs[0]?.favicon).toBe('https://a.example/favicon.ico')
  })

  test('弹窗一律拒：http(s) 的目标改成宿主开一个新标签', () => {
    h.tabs.openTab('https://a.example/')

    const handler = lastView(h).webContents.openHandler.current

    expect(handler?.({ url: 'https://b.example/' })).toEqual({ action: 'deny' })
    expect(h.tabs.state().tabs).toHaveLength(2)
    expect(lastView(h).webContents.loaded.at(-1)).toBe('https://b.example/')

    expect(handler?.({ url: 'file:///etc/passwd' })).toEqual({ action: 'deny' })
    expect(h.tabs.state().tabs).toHaveLength(2)
  })

  test('导航限制：非 http(s)/about 的地址被拦下', () => {
    h.tabs.openTab('https://a.example/')

    let prevented = 0
    const event = {
      preventDefault: () => {
        prevented += 1
      },
    }

    lastView(h).webContents.emit('will-navigate', event, 'file:///etc/passwd')
    expect(prevented).toBe(1)

    lastView(h).webContents.emit('will-navigate', event, 'https://b.example/')
    expect(prevented).toBe(1)
  })

  test('拾取回调地址交给 index.ts，且被拦下（不是一次导航）', () => {
    h.tabs.openTab('https://a.example/')

    let prevented = 0

    lastView(h).webContents.emit(
      'will-navigate',
      {
        preventDefault: () => {
          prevented += 1
        },
      },
      'https://pick.poietica.invalid/?token=t&kind=cancelled',
    )

    expect(prevented).toBe(1)
    expect(h.picked).toEqual(['https://pick.poietica.invalid/?token=t&kind=cancelled'])
  })

  test('back/forward 走内核的导航历史，不是页面里的 history.back()', () => {
    h.tabs.openTab('https://a.example/')

    h.tabs.back(1)
    h.tabs.back(1)
    h.tabs.forward(1)

    // 退过一次之后 canGoBack 已经为假，第二次 back 不该再落到内核上。
    expect(h.created[0]?.webContents.navigationHistory.canGoBack()).toBe(false)
    expect(h.tabs.state().tabs[0]?.canGoBack).toBe(false)
  })

  test('setZoom 落内核并把档位写进标签面', () => {
    h.tabs.openTab('https://a.example/')
    h.tabs.setZoom(1, 3)

    expect(lastView(h).webContents.zoom.level).toBe(3)
    expect(lastView(h).webContents.zoom.mode).toBe('isolated')
    expect(h.tabs.state().tabs[0]?.zoom).toBe(3)
  })

  test('渲染进程崩溃：第一次 reload，60 秒内第二次显示空白并保留标签', () => {
    h.tabs.openTab('https://a.example/')
    const only = lastView(h)

    only.webContents.emit('render-process-gone')
    expect(h.tabs.state().tabs[0]?.url).toBe('https://a.example/')

    h.clock.advance(10_000)
    only.webContents.emit('render-process-gone')

    expect(h.tabs.state().tabs[0]?.url).toBeNull()
    expect(h.tabs.state().tabs).toHaveLength(1)
  })
})

describe('拾取租约与面板收合', () => {
  test('setPicking 写状态；换标签会退掉上一个面板', () => {
    h.tabs.openTab('https://a.example/')
    h.tabs.openTab('https://b.example/')

    h.tabs.setPicking(1)
    expect(h.tabs.state().pickingTabId).toBe(1)

    h.tabs.selectTab(2)

    expect(h.created[0]?.webContents.injected).toContain('window.__poieticaElementPicker?.cancel();')
    expect(h.tabs.state().pickingTabId).toBeNull()
  })

  test('收起面板时停掉拾取', () => {
    h.tabs.openTab('https://a.example/')
    h.tabs.setPicking(1)
    h.tabs.setVisible(false)

    expect(h.tabs.state().pickingTabId).toBeNull()
  })
})
