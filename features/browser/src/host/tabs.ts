import { AppError, type Clock, type Disposable, type Logger, systemClock, toDisposable } from '@poietica/foundation'
import { BLANK_PAGE, BROWSER_PARTITION, type BrowserState, type BrowserTab, PICKER_WORLD } from '../contract/entities'
import { browserErrors } from '../contract/errors'
import { displayHost, isNavigableAddress, isWebAddress, normalizeAddress } from './address'

/*
 * 标签与视图（07 页 §12D 的规则表）。**迁移自** legacy
 * `apps/desktop/electron/browser/host.ts` 的 createBrowserHost，拆成「electron 通过
 * ViewHost 注入」的形状：
 *
 *   - createView / attach / detach / zoomFactor / onResize 由 index.ts 用主窗口实现；
 *   - tabs.ts 不 import electron，测试喂假视图就能钉住 BR-10 与摆放规则。
 *
 * 语义一字未改：只有活动标签的视图可见、全部共享同一个矩形、关标签先右后左、
 * 空白页不进最近关闭环、CDP 导航落账后要当场重摆（只 publish 不 layout 会让 agent
 * 打开的页面在面板里没有画面）。
 */

export interface RectangleLike {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

/** 监听器签名只用来挡类型：内核的事件都是 (event, ...payload)。 */
export type ContentsListener = (...args: never[]) => void

/** WebContents 里 browser 模块用到的那一份子集（tabs 与 relay 共用）。 */
export interface WebContentsLike {
  getURL(): string
  isLoading(): boolean
  loadURL(url: string): Promise<void>
  close(): void
  reload(): void
  stop(): void
  setZoomLevel(level: number): void
  getZoomLevel(): number
  setZoomMode(mode: 'isolated' | 'proportional'): void
  executeJavaScriptInIsolatedWorld(worldId: number, scripts: readonly { code: string }[]): Promise<unknown>
  readonly navigationHistory: {
    canGoBack(): boolean
    canGoForward(): boolean
    goBack(): void
    goForward(): void
  }
  setWindowOpenHandler(handler: (details: { url: string }) => { action: 'deny' | 'allow' }): void
  on(event: string, listener: ContentsListener): void
  readonly debugger: DebuggerLike
}

/** webContents.debugger 里 relay 用到的那一份子集（与 Chrome 扩展的 chrome.debugger 同一套 CDP）。 */
export interface DebuggerLike {
  isAttached(): boolean
  attach(protocolVersion?: string): void
  detach(): void
  sendCommand(method: string, commandParams?: Record<string, unknown>, sessionId?: string): Promise<unknown>
  on(event: 'message', listener: ContentsListener): void
  on(event: 'detach', listener: ContentsListener): void
}

export interface WebContentsViewLike {
  readonly webContents: WebContentsLike
  setBounds(rect: RectangleLike): void
  setVisible(visible: boolean): void
}

export interface ViewHost {
  /** 按 §12D 的 webPreferences 创建视图（没有 preload） */
  createView(): WebContentsViewLike
  attach(view: WebContentsViewLike): void
  detach(view: WebContentsViewLike): void
  /** win.webContents.getZoomFactor()：CSS 像素 × 它 = 视图要的像素 */
  zoomFactor(): number
  onResize(fn: () => void): Disposable
}

export interface BrowserTabs {
  state(): BrowserState
  /** 16ms 合批；同一批里只有最后一次变化被送出 */
  onState(listener: (s: BrowserState) => void): Disposable
  /** 地址归一失败返回 null；成功时新标签成为活动标签 */
  openTab(url: string | null): number | null
  closeTab(tabId: number): void
  selectTab(tabId: number): void
  reopenClosed(index: number): void
  navigate(tabId: number, url: string): void
  back(tabId: number): void
  forward(tabId: number): void
  reload(tabId: number): void
  stop(tabId: number): void
  setZoom(tabId: number, level: number): void
  setBounds(rect: RectangleLike): void
  setVisible(visible: boolean): void
  setPicking(tabId: number | null): void
  setDriven(driven: boolean): void
  contentsOf(tabId: number): WebContentsLike | null
  disposeAll(): void
}

export interface BrowserTabsOptions {
  readonly logger: Logger
  readonly clock?: Clock
  /** 拾取回调地址在 will-navigate / will-redirect 上被拦住时叫一次（解码与租约归 index.ts） */
  readonly onPickerCallback: (tabId: number, url: string) => void
}

const RECENTLY_CLOSED_CAP = 10
const STATE_BATCH_MS = 16
const CRASH_WINDOW_MS = 60_000

interface Tab {
  readonly id: number
  url: string | null
  title: string
  loading: boolean
  favicon: string | null
  canGoBack: boolean
  canGoForward: boolean
  zoom: number
  shown: boolean
  crashedAt: number | null
  readonly view: WebContentsViewLike
}

export function createBrowserTabs(host: ViewHost, opts: BrowserTabsOptions): BrowserTabs {
  const clock = opts.clock ?? systemClock
  const tabs: Tab[] = []
  const recentlyClosed: { url: string; title: string }[] = []
  const stateListeners = new Set<(s: BrowserState) => void>()
  let activeTabId: number | null = null
  let pickingTabId: number | null = null
  let driven = false
  let nextId = 1
  let revision = 0
  let bounds: RectangleLike = { x: 0, y: 0, width: 1, height: 1 }
  let visible = false
  let batchTimer: Disposable | null = null
  let disposed = false

  const find = (id: number): Tab | undefined => tabs.find((tab) => tab.id === id)

  const require = (id: number): Tab => {
    const tab = find(id)

    if (tab === undefined) {
      throw new AppError(browserErrors.tab_not_found, `标签 ${String(id)} 不存在`)
    }

    return tab
  }

  function read(): BrowserState {
    return {
      revision,
      tabs: tabs.map(
        (tab): BrowserTab => ({
          id: tab.id,
          url: tab.url,
          title: tab.title,
          loading: tab.loading,
          favicon: tab.favicon,
          canGoBack: tab.canGoBack,
          canGoForward: tab.canGoForward,
          zoom: tab.zoom,
        }),
      ),
      activeTabId,
      pickingTabId,
      recentlyClosed: [...recentlyClosed],
      driven,
    }
  }

  function flush(): void {
    if (disposed) {
      return
    }

    const state = read()

    for (const listener of [...stateListeners]) {
      listener(state)
    }
  }

  /** 每次变化 +1；通知按 16ms 合批，批里只有最后一帧被送出（revision 单调，UI 丢旧的）。 */
  function publish(): void {
    revision += 1

    if (batchTimer === null) {
      batchTimer = clock.setTimeout(() => {
        batchTimer = null
        flush()
      }, STATE_BATCH_MS)
    }
  }

  /** 当前该显示哪一页：只有活动标签，且它真的导航过（空白标签没有要显示的东西）。 */
  const showing = (): Tab | undefined => {
    const tab = activeTabId === null ? undefined : find(activeTabId)

    return tab?.url === null ? undefined : tab
  }

  /** 摆放只有这一处：活动标签贴着面板矩形，其余一律不画。窗口 resize 也走它。 */
  function layout(): void {
    const target = showing()
    const factor = host.zoomFactor()
    const scale = Number.isFinite(factor) && factor > 0 ? factor : 1

    for (const tab of tabs) {
      const shown = visible && tab === target

      /* 几何先于可见性：点亮的那一帧必须已经有真实矩形，否则视图会先按上一次的矩形
         （没上报过时就是 1×1）亮一下。内核不接受零尺寸，面板收起/极窄时至少留一像素。 */
      if (shown) {
        tab.view.setBounds({
          x: Math.round(bounds.x * scale),
          y: Math.round(bounds.y * scale),
          width: Math.max(1, Math.round(bounds.width * scale)),
          height: Math.max(1, Math.round(bounds.height * scale)),
        })
      }

      /* 只在真的翻转时才叫内核：面板拖动是每帧一次的通报，逐帧重复同一个值是白付的。 */
      if (shown !== tab.shown) {
        tab.shown = shown
        tab.view.setVisible(shown)
      }
    }
  }

  function syncHistory(tab: Tab): void {
    tab.canGoBack = tab.view.webContents.navigationHistory.canGoBack()
    tab.canGoForward = tab.view.webContents.navigationHistory.canGoForward()
  }

  function noteUrl(tab: Tab, url: string): void {
    /* 地址是「这一页有没有东西可摆」的判据，所以它与几何、可见性同批结算：agent 经 CDP
       导航过来的页面（空白标签 → 真站点）要当场被摆上。 */
    tab.url = url === BLANK_PAGE || url.length === 0 ? null : url
    syncHistory(tab)
    layout()
    publish()
  }

  function setLoading(tab: Tab, loading: boolean): void {
    if (tab.loading === loading) {
      return
    }

    tab.loading = loading
    publish()
  }

  function inject(tabId: number, code: string): void {
    const tab = find(tabId)

    if (tab === undefined) {
      return
    }

    tab.view.webContents.executeJavaScriptInIsolatedWorld(PICKER_WORLD, [{ code }]).catch((cause: unknown) => {
      opts.logger.warn('browser picker injection rejected', { tabId, error: String(cause) })
    })
  }

  /* 拾取租赁约归 index.ts；这里只把取消脚本送进页面（换标签、导航、隐藏面板时都要退掉上一个面板）。 */
  function cancelPick(tabId: number): void {
    inject(tabId, 'window.__poieticaElementPicker?.cancel();')
  }

  function stopPickerUnless(id: number): void {
    if (pickingTabId !== null && pickingTabId !== id) {
      cancelPick(pickingTabId)
      pickingTabId = null
    }
  }

  function createView(): WebContentsViewLike {
    const view = host.createView()
    const contents = view.webContents

    /* 缩放按标签隔离，不按 origin 共享：面板给每一格发了自己的缩放键。 */
    contents.setZoomMode('isolated')

    // 外站不许开自己的窗口：http(s) 交给宿主开一个新标签，其余直接丢。
    contents.setWindowOpenHandler(({ url }) => {
      if (isWebAddress(url)) {
        openTab(url)
      } else {
        opts.logger.warn('browser refused to open non-web url', { url })
      }

      return { action: 'deny' }
    })

    const onNavigation = (event: { preventDefault(): void }, url: string): void => {
      // 拾取面板的回调不是一次导航，是它把结果送回来的唯一一条路：拦住、交给 index.ts。
      if (url.startsWith('https://pick.poietica.invalid/')) {
        event.preventDefault()
        opts.onPickerCallback(tabOf(contents)?.id ?? -1, url)

        return
      }

      if (!isNavigableAddress(url)) {
        event.preventDefault()
      }
    }

    contents.on('will-navigate', (event: unknown, url: unknown) => {
      if (typeof url === 'string') {
        onNavigation(event as { preventDefault(): void }, url)
      }
    })
    contents.on('will-redirect', (event: unknown, url: unknown) => {
      if (typeof url === 'string') {
        onNavigation(event as { preventDefault(): void }, url)
      }
    })

    contents.on('did-navigate', (_event: unknown, url: unknown) => {
      const tab = tabOf(contents)

      if (tab !== undefined && typeof url === 'string') {
        noteUrl(tab, url)
      }
    })
    contents.on('did-navigate-in-page', (_event: unknown, url: unknown) => {
      const tab = tabOf(contents)

      if (tab !== undefined && typeof url === 'string') {
        noteUrl(tab, url)
      }
    })

    contents.on('page-title-updated', (_event: unknown, title: unknown) => {
      const tab = tabOf(contents)

      if (tab !== undefined && typeof title === 'string' && title.length > 0) {
        tab.title = title
        publish()
      }
    })

    contents.on('page-favicon-updated', (_event: unknown, favicons: unknown) => {
      const tab = tabOf(contents)
      const icon = Array.isArray(favicons)
        ? (favicons.find((candidate) => typeof candidate === 'string' && candidate.length > 0) ?? null)
        : null

      if (tab !== undefined && tab.favicon !== icon) {
        tab.favicon = typeof icon === 'string' ? icon : null
        publish()
      }
    })

    contents.on('did-start-loading', () => {
      const tab = tabOf(contents)

      if (tab !== undefined) {
        setLoading(tab, true)
      }
    })
    contents.on('did-stop-loading', () => {
      const tab = tabOf(contents)

      if (tab !== undefined) {
        setLoading(tab, false)
        syncHistory(tab)
        publish()
      }
    })

    /* 渲染进程崩溃：reload 一次；60 秒内第二次崩溃就显示空白并保留标签。 */
    contents.on('render-process-gone', () => {
      const tab = tabOf(contents)

      if (tab === undefined) {
        return
      }

      const now = clock.now()
      const again = tab.crashedAt !== null && now - tab.crashedAt < CRASH_WINDOW_MS

      tab.crashedAt = now

      if (again) {
        opts.logger.error('browser renderer crashed twice; leaving the tab blank', { tabId: tab.id })
        tab.url = null
        tab.loading = false
        layout()
        publish()
        return
      }

      contents.reload()
    })

    host.attach(view)
    view.setVisible(false)

    return view
  }

  /** 视图 → 标签：事件回调里只有 contents，没有 id。 */
  function tabOf(contents: WebContentsLike): Tab | undefined {
    return tabs.find((tab) => tab.view.webContents === contents)
  }

  function openTab(url: string | null): number | null {
    if (pickingTabId !== null) {
      cancelPick(pickingTabId)
      pickingTabId = null
    }

    const normalized = url === null ? null : normalizeAddress(url)

    if (url !== null && normalized === null) {
      opts.logger.debug('browser refused an unparsable address', { url })

      return null
    }

    const view = createView()
    const id = nextId

    nextId += 1

    const tab: Tab = {
      id,
      url: normalized,
      title: normalized === null ? '新标签页' : displayHost(normalized),
      loading: normalized !== null,
      favicon: null,
      canGoBack: false,
      canGoForward: false,
      zoom: 0,
      shown: false,
      crashedAt: null,
      view,
    }

    tabs.push(tab)
    activeTabId = id

    if (normalized !== null) {
      void view.webContents.loadURL(normalized).catch((cause: unknown) => {
        opts.logger.warn('browser failed to load url', { tabId: id, url: normalized, error: String(cause) })
      })
    }

    layout()
    publish()

    return id
  }

  function closeTab(id: number): void {
    const tab = require(id)
    const index = tabs.indexOf(tab)

    if (pickingTabId === id) {
      cancelPick(id)
      pickingTabId = null
    }

    tabs.splice(index, 1)

    if (tab.url !== null) {
      if (recentlyClosed.length === RECENTLY_CLOSED_CAP) {
        recentlyClosed.pop()
      }

      recentlyClosed.unshift({ url: tab.url, title: tab.title })
    }

    if (activeTabId === id) {
      // 先右后左：关掉最右一页时焦点才回到左边那页。
      const next = tabs[index] ?? tabs[index - 1]

      activeTabId = next?.id ?? null
    }

    host.detach(tab.view)
    tab.view.webContents.close()

    layout()
    publish()
  }

  function drive(tab: Tab, address: string): void {
    const normalized = normalizeAddress(address)

    if (normalized === null) {
      throw new AppError(browserErrors.invalid_url, `无法识别的地址：${address}`)
    }

    tab.url = normalized
    tab.title = displayHost(normalized)
    tab.loading = true

    void tab.view.webContents.loadURL(normalized).catch((cause: unknown) => {
      opts.logger.warn('browser failed to load url', { tabId: tab.id, url: normalized, error: String(cause) })
    })

    layout()
    publish()
  }

  const resize = host.onResize(() => {
    layout()
  })

  return {
    state: read,

    onState(listener) {
      stateListeners.add(listener)

      return toDisposable(() => {
        stateListeners.delete(listener)
      })
    },

    openTab,

    closeTab,

    selectTab(id) {
      const tab = require(id)

      stopPickerUnless(id)
      activeTabId = tab.id
      layout()
      publish()
    },

    reopenClosed(index) {
      const [record] = recentlyClosed.splice(index, 1)

      if (record === undefined) {
        return
      }

      openTab(record.url)
    },

    navigate(id, address) {
      const tab = require(id)

      if (pickingTabId === id) {
        cancelPick(id)
        pickingTabId = null
        publish()
      }

      drive(tab, address)
    },

    back(id) {
      const tab = require(id)

      if (tab.view.webContents.navigationHistory.canGoBack()) {
        tab.view.webContents.navigationHistory.goBack()
      }

      layout()
      publish()
    },

    forward(id) {
      const tab = require(id)

      if (tab.view.webContents.navigationHistory.canGoForward()) {
        tab.view.webContents.navigationHistory.goForward()
      }

      layout()
      publish()
    },

    reload(id) {
      const tab = require(id)

      tab.view.webContents.reload()
      layout()
      publish()
    },

    stop(id) {
      const tab = require(id)

      tab.view.webContents.stop()
      publish()
    },

    setZoom(id, level) {
      const tab = require(id)

      tab.zoom = level
      tab.view.webContents.setZoomLevel(level)
      publish()
    },

    setBounds(rect) {
      bounds = rect
      layout()
    },

    setVisible(next) {
      /*
       * 收起面板也要停掉拾取：原生视图藏了，页面上那层面板却还在等人点，
       * 用户会以为没关掉（legacy 的 setVisible(false) → stopPicker 同此）。
       */
      if (!next && pickingTabId !== null) {
        cancelPick(pickingTabId)
        pickingTabId = null
      }

      visible = next
      layout()
      publish()
    },

    setPicking(tabId) {
      if (pickingTabId === tabId) {
        return
      }

      pickingTabId = tabId
      publish()
    },

    setDriven(next) {
      if (driven === next) {
        return
      }

      driven = next
      publish()
    },

    contentsOf(id) {
      return find(id)?.view.webContents ?? null
    },

    disposeAll() {
      disposed = true
      batchTimer?.dispose()
      batchTimer = null
      resize.dispose()

      for (const tab of tabs) {
        host.detach(tab.view)
        tab.view.webContents.close()
      }

      tabs.length = 0
      recentlyClosed.length = 0
      activeTabId = null
      pickingTabId = null
      stateListeners.clear()
    },
  }
}

/** 视图创建时用的窗口偏好（07 页 §12D 的规则表；index.ts 把它交给 WebContentsView）。 */
export const BROWSER_VIEW_PREFERENCES = {
  partition: BROWSER_PARTITION,
  sandbox: true,
  contextIsolation: true,
  nodeIntegration: false,
  webSecurity: true,
  spellcheck: false,
} as const
