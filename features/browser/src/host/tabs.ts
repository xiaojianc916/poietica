import { AppError, type Clock, type Disposable, type Logger, systemClock, toDisposable } from '@poietica/foundation'
import { BLANK_PAGE, BROWSER_PARTITION, type BrowserState, type BrowserTab, PICKER_WORLD } from '../contract/entities'
import { browserErrors } from '../contract/errors'
import { displayHost, isNavigableAddress, isWebAddress, normalizeAddress } from './address'

/* 标签与视图。createView / attach / detach / zoomFactor / onResize 由 index.ts 注入，本文件不 import
 * electron，测试喂假视图即可钉住 BR-10。CDP 导航落账后必须当场重摆：只 publish 不 layout，agent 打开的
 * 页面在面板里没有画面。 */

export interface RectangleLike {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

export type ContentsListener = (...args: never[]) => void

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
  /** 后台标签会被 Chromium 降频，AI 附着期间要关掉它（B-03）。 */
  setBackgroundThrottling(allowed: boolean): void
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
  createView(): WebContentsViewLike
  attach(view: WebContentsViewLike): void
  detach(view: WebContentsViewLike): void
  /** CSS 像素 × 它 = 视图要的像素 */
  zoomFactor(): number
  onResize(fn: () => void): Disposable
}

export interface BrowserTabs {
  /** 给面板看的标签面：不含备用标签。 */
  state(): BrowserState
  /** 给 relay 看的标签面：含备用标签（omp 要有页可接管），备用标签在没有别的活动标签时算活动。 */
  relayState(): BrowserState
  /**
   * 保证 agent 有页可用：一张标签都没有（连备用标签也没有）时补一张**备用标签**。幂等，可以在每次状态变化时叫。
   * omp 把这里当「借来的浏览器」，按设计从不自己开页；页面供给只能由宿主负责。
   */
  ensureAgentPage(): void
  onState(listener: (s: BrowserState) => void): Disposable
  openTab(url: string | null, active?: boolean): number | null
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
  /** 拦到拾取回调地址时叫一次（解码与租约归 index.ts） */
  readonly onPickerCallback: (tabId: number, url: string) => void
  /**
   * 把页面报上来的图标候选换成界面能画的受信地址（favicon.ts，由 index.ts 接上浏览器分区的会话）。
   * 不给就没有图标 —— 外站原始地址永远不进标签状态。
   */
  readonly resolveFavicon?: (candidates: readonly string[], pageUrl: string) => Promise<string | null>
}

const RECENTLY_CLOSED_CAP = 10
const STATE_BATCH_MS = 16
const CRASH_WINDOW_MS = 60_000

/** 常见桌面视口；面板没上报过像样矩形时，AI 截图与排版按它来。 */
const FALLBACK_BOUNDS: RectangleLike = { x: 0, y: 0, width: 1280, height: 800 }
const MIN_USABLE_EDGE = 200

interface Tab {
  readonly id: number
  url: string | null
  title: string
  loading: boolean
  /** 只放 resolveFavicon 给的受信地址。 */
  favicon: string | null
  /** 每换一页（或换一批候选）+1：晚到的取图结果对不上号就丢，免得上一页的图标落到这一页。 */
  faviconTicket: number
  /** 这一页有没有发起过取图；页面一个图标都没声明时，停止装载那一刻补取 /favicon.ico。 */
  faviconAsked: boolean
  canGoBack: boolean
  canGoForward: boolean
  zoom: number
  shown: boolean
  /** 上一次下发的矩形指纹：拖动每帧通报一次，同值不重复叫内核。 */
  rectKey: string | null
  crashedAt: number | null
  /**
   * 备用标签：只报给 relay、不进面板。用户把面板关空后 agent 仍有页可接管，面板也不会冒出一张关不掉的空白页。
   * 被导航到真实地址（agent 打开了网页）就转正成普通标签。
   */
  reserve: boolean
  readonly view: WebContentsViewLike
}

export function createBrowserTabs(host: ViewHost, opts: BrowserTabsOptions): BrowserTabs {
  const clock = opts.clock ?? systemClock
  const resolveFavicon = opts.resolveFavicon ?? (() => Promise.resolve(null))
  const tabs: Tab[] = []
  const recentlyClosed: { url: string; title: string }[] = []
  const stateListeners = new Set<(s: BrowserState) => void>()
  let activeTabId: number | null = null
  let pickingTabId: number | null = null
  let driven = false
  let nextId = 1
  let revision = 0
  let bounds: RectangleLike = { x: 0, y: 0, width: 1, height: 1 }
  let usable: RectangleLike | null = null
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

  /* 面板只看普通标签；relay 看全部。activeTabId 从不指向备用标签（转正之前它不抢活动位）。 */
  function read(): BrowserState {
    return snapshot(
      tabs.filter((tab) => !tab.reserve),
      activeTabId,
    )
  }

  function readForRelay(): BrowserState {
    return snapshot(tabs, activeTabId ?? tabs.find((tab) => tab.reserve)?.id ?? null)
  }

  function snapshot(shown: readonly Tab[], active: number | null): BrowserState {
    return {
      revision,
      tabs: shown.map(
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
      activeTabId: active,
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

  /** 每次变化 +1；16ms 合批只送最后一帧，UI 靠单调 revision 丢旧的。 */
  function publish(): void {
    revision += 1

    if (batchTimer === null) {
      batchTimer = clock.setTimeout(() => {
        batchTimer = null
        flush()
      }, STATE_BATCH_MS)
    }
  }

  /** 只有活动标签且真的导航过才显示：空白标签没有可显示的东西。 */
  const showing = (): Tab | undefined => {
    const tab = activeTabId === null ? undefined : find(activeTabId)

    return tab?.url === null ? undefined : tab
  }

  /** 内核不接受零尺寸，收起或极窄时至少留一像素。 */
  function scaled(rect: RectangleLike, scale: number): RectangleLike {
    return {
      x: Math.round(rect.x * scale),
      y: Math.round(rect.y * scale),
      width: Math.max(1, Math.round(rect.width * scale)),
      height: Math.max(1, Math.round(rect.height * scale)),
    }
  }

  /* 摆放只有这一处：每张标签都摆，可见性只给目标那张。只摆显示中那张，relay 附着的后台标签会按 1×1 排版（截图 1×1、按坐标的点击落空，B-02）。 */
  /** 几何先于可见性：点亮那一帧必须已有真实矩形，否则会先按上一次的亮一下。 */
  function place(tab: Tab, rect: RectangleLike, shown: boolean, scale: number): void {
    const key = `${String(rect.x)},${String(rect.y)},${String(rect.width)},${String(rect.height)},${String(scale)}`

    if (tab.rectKey !== key) {
      tab.rectKey = key
      tab.view.setBounds(scaled(rect, scale))
    }

    if (shown !== tab.shown) {
      tab.shown = shown
      tab.view.setVisible(shown)
    }
  }

  function layout(): void {
    const target = showing()
    const factor = host.zoomFactor()
    const scale = Number.isFinite(factor) && factor > 0 ? factor : 1
    const aside = usable ?? FALLBACK_BOUNDS

    for (const tab of tabs) {
      const shown = visible && tab === target

      place(tab, shown ? bounds : aside, shown, scale)
    }
  }

  function syncHistory(tab: Tab): void {
    tab.canGoBack = tab.view.webContents.navigationHistory.canGoBack()
    tab.canGoForward = tab.view.webContents.navigationHistory.canGoForward()
  }

  function noteUrl(tab: Tab, url: string): void {
    /* 地址是「有没有东西可摆」的判据，与几何、可见性同批结算：CDP 导航过来的页面要当场摆上。 */
    tab.url = url === BLANK_PAGE || url.length === 0 ? null : url

    /* agent 把备用标签导航到了真实地址：转正，进面板；面板上没有活动标签时它就是活动标签。 */
    if (tab.reserve && tab.url !== null) {
      tab.reserve = false

      if (activeTabId === null) {
        activeTabId = tab.id
      }
    }

    syncHistory(tab)
    layout()
    publish()
  }

  /* 新文档提交即作废旧图标：没有图标的页面不该顶着上一个站点的脸。同文档内跳转（锚点、pushState）不走这里。 */
  function resetFavicon(tab: Tab): void {
    tab.faviconTicket += 1
    tab.faviconAsked = false
    tab.favicon = null
  }

  function requestFavicon(tab: Tab, candidates: readonly string[]): void {
    const pageUrl = tab.url

    if (pageUrl === null || !isWebAddress(pageUrl)) {
      return
    }

    tab.faviconAsked = true
    tab.faviconTicket += 1

    const ticket = tab.faviconTicket

    resolveFavicon(candidates, pageUrl).then(
      (icon) => {
        if (disposed || find(tab.id) !== tab || tab.faviconTicket !== ticket) {
          return
        }

        // 取不回来不清掉已有的：页面换图标（比如未读角标）失败时，留着上一张比退回地球强。
        if (icon !== null && tab.favicon !== icon) {
          tab.favicon = icon
          publish()
        }
      },
      (cause: unknown) => {
        opts.logger.debug('browser favicon resolve failed', { tabId: tab.id, error: String(cause) })
      },
    )
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

  /* 租约归 index.ts；这里只把取消脚本送进页面（换标签、导航、隐藏面板都要退掉上一个面板）。 */
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

    contents.setZoomMode('isolated')

    // 外站不许开自己的窗口：http(s) 转交宿主开新标签，其余丢弃。
    contents.setWindowOpenHandler(({ url }) => {
      if (isWebAddress(url)) {
        openTab(url)
      } else {
        opts.logger.warn('browser refused to open non-web url', { url })
      }

      return { action: 'deny' }
    })

    const onNavigation = (event: { preventDefault(): void }, url: string): void => {
      // 拾取回调不是导航，是结果回来的唯一一条路：拦住交给 index.ts。
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
        resetFavicon(tab)
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

    /* 这里拿到的只是页面声明的候选（外站说了算的任意地址），交给 resolveFavicon 代取，结果回来再进状态。 */
    contents.on('page-favicon-updated', (_event: unknown, favicons: unknown) => {
      const tab = tabOf(contents)

      if (tab === undefined) {
        return
      }

      const candidates = Array.isArray(favicons)
        ? favicons.filter((candidate): candidate is string => typeof candidate === 'string' && candidate.length > 0)
        : []

      requestFavicon(tab, candidates)
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

        if (!tab.faviconAsked) {
          requestFavicon(tab, [])
        }

        publish()
      }
    })

    /* 崩溃后 reload 一次；60 秒内第二次崩溃就显示空白并保留标签。 */
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
        resetFavicon(tab)
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

  function tabOf(contents: WebContentsLike): Tab | undefined {
    return tabs.find((tab) => tab.view.webContents === contents)
  }

  function openTab(url: string | null, active = true): number | null {
    return addTab(url, active, false)
  }

  function ensureAgentPage(): void {
    if (disposed || tabs.length > 0) {
      return
    }

    addTab(null, false, true)
  }

  function addTab(url: string | null, active: boolean, reserve: boolean): number | null {
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
      faviconTicket: 0,
      faviconAsked: false,
      canGoBack: false,
      canGoForward: false,
      zoom: 0,
      shown: false,
      rectKey: null,
      crashedAt: null,
      reserve,
      view,
    }

    tabs.push(tab)

    /* 后台标签不许把「当前没有活动标签」的空档留着 —— 那会让面板一张都不显示。备用标签不进面板，也就不占活动位。 */
    if (!reserve && (active || activeTabId === null)) {
      activeTabId = id
    }

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
      /* 仍然先右后左，但备用标签不进面板：面板的活动位只交给普通标签，剩下的空档由 relay 那一侧自己挑备用页。 */
      const right = tabs.slice(index).find((tab) => !tab.reserve)
      const left = [...tabs.slice(0, index)].reverse().find((tab) => !tab.reserve)

      activeTabId = right?.id ?? left?.id ?? null
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

    relayState: readForRelay,

    ensureAgentPage,

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

      /* relay 的 activateTab 可能点到备用标签：它不在面板里，没有可切换的画面；在 relay 那一侧它本来就算活动。 */
      if (tab.reserve) {
        return
      }

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

      if (rect.width >= MIN_USABLE_EDGE && rect.height >= MIN_USABLE_EDGE) {
        usable = rect
      }

      layout()
    },

    setVisible(next) {
      /* 收起面板也要停掉拾取：视图藏了而页面上的面板还在等人点，用户会以为没关掉。 */
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

export const BROWSER_VIEW_PREFERENCES = {
  partition: BROWSER_PARTITION,
  sandbox: true,
  contextIsolation: true,
  nodeIntegration: false,
  webSecurity: true,
  spellcheck: false,
} as const
