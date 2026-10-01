/*
 * 内嵌浏览器的宿主侧：一个标签一个 WebContentsView。
 *
 * 标签模型照搬 crates/browser 的语义（open/close/select/navigate 与 note_url/note_title/note_loading、
 * 空白页是「没有 url」而不是一条 about:blank 记录），但用 TypeScript 重写在这一个文件里：
 * 标签是宿主自己的状态，跨进程叫一遍原生只会多一个单写者。
 *
 * 产出形状的正本是 packages/contract/src/browser.ts（字段名与它逐字相同）；
 * 状态事件名沿用生成物里 events.browserState 的字符串 'browser-state'。
 *
 * 元素拾取的注入脚本与 token 语义在 ./element-picker.ts；这里只负责什么时候租、什么时候收。
 */

import type { BrowserWindow, Rectangle } from 'electron'
import { WebContentsView } from 'electron'

import {
  createPicker,
  decodePickerCallback,
  isPickerCallback,
  loadPickerScript,
  PICKER_CANCEL_SCRIPT,
  type Picker,
  type PickOutcome,
  pickerStartScript,
  writeElementReport,
} from './element-picker'

/** 空白页写法的唯一产地，与 crates/browser 的 BLANK_PAGE 同一个值。 */
const BLANK_PAGE = 'about:blank'
const RECENTLY_CLOSED_CAP = 10

/**
 * 拾取脚本住的隔离世界。外站页面的 CSP 拦得住注入，隔离世界拦不住；
 * 0 是页面主世界，不能用 —— 注入进去就会被页面自己的 CSP 判死。
 */
const PICKER_WORLD = 999

/** 外站视图的用户数据与主界面分开，也方便权限在这一个会话上收紧（main.ts 装 handler）。 */
export const BROWSER_PARTITION = 'persist:poietica-browser'

interface Tab {
  id: number
  url: string | null
  title: string
  loading: boolean
  view: WebContentsView
}

interface ClosedTab {
  url: string
  title: string
}

/** 与 packages/contract/src/browser.ts 的 BrowserState 逐字段相同。 */
export interface BrowserState {
  revision: number
  tabs: {
    id: number
    url: string | null
    title: string
    loading: boolean
    favicon: string | null
  }[]
  activeTabId: number | null
  pickingTabId: number | null
  recentlyClosed: ClosedTab[]
}

export interface BrowserElementPicked {
  tabId: number
  submission: 'attach' | 'send'
  elementType: string
  comment: string
  reportPath: string
}

export interface BrowserHost {
  state(): BrowserState
  openTab(url?: string | null): void
  closeTab(id: number): void
  selectTab(id: number): void
  navigate(id: number, address: string): void
  back(id: number): void
  forward(id: number): void
  reload(id: number): void
  print(id: number): void
  reopenClosed(index: number): void
  setBounds(rect: Rectangle): void
  /** 窗口尺寸变了但面板矩形没变时重摆一次；矩形本身归渲染层上报。 */
  relayout(): void
  setVisible(visible: boolean): void
  setElementPicker(id: number, enabled: boolean, theme: 'light' | 'dark'): void
  dispose(): void
}

export interface BrowserHostDeps {
  /** 拾取结果往渲染层送一次。写报告文件是这里的活，送出去由主进程决定。 */
  onElementPicked(picked: BrowserElementPicked): void
}

/**
 * 地址归一：只有 http(s) 与本地 file: 进得来，裸主机名补 scheme。
 * 与 crates/browser 的 normalize_address 同一套判据 —— 搜索词不是地址，打错的地址也不该被当成站点。
 */
function normalizeAddress(input: string): string | null {
  const trimmed = input.trim()

  if (trimmed.length === 0) {
    return null
  }

  // 只有带 '://' 的写法才算「写明了 scheme」：'localhost:5173' 是主机加端口，不是 scheme。
  if (trimmed.includes('://') || trimmed.startsWith('file:')) {
    let parsed: URL

    try {
      parsed = new URL(trimmed)
    } catch {
      return null
    }

    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
      return parsed.hostname.length > 0 ? parsed.toString() : null
    }

    // 本地文件是要看的：宿主把 file: 当自定义协议装载，所以这里放行，只有带主机的 file: 才是歧义。
    return parsed.protocol === 'file:' &&
      parsed.hostname.length === 0 &&
      parsed.pathname.startsWith('/')
      ? parsed.toString()
      : null
  }

  if (trimmed.includes(' ')) {
    return null
  }

  const scheme = isLocalAuthority(trimmed) ? 'http' : 'https'
  let parsed: URL

  try {
    parsed = new URL(`${scheme}://${trimmed}`)
  } catch {
    return null
  }

  // 裸主机名不带点更可能是没打完的搜索词；本地地址（localhost、IP）已经在上面走了 http。
  return scheme === 'https' && !parsed.hostname.includes('.') ? null : parsed.toString()
}

function isLocalAuthority(address: string): boolean {
  const authority = address.split('/')[0] ?? address
  const colon = authority.lastIndexOf(':')
  const host = colon === -1 ? authority : authority.slice(0, colon)

  return host === 'localhost' || /^\d{1,3}(\.\d{1,3}){3}$/u.test(host)
}

function displayHost(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

function isWebAddress(url: string): boolean {
  try {
    const protocol = new URL(url).protocol

    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return false
  }
}

export function createBrowserHost(
  win: BrowserWindow,
  onStateChanged: (state: BrowserState) => void,
  deps: BrowserHostDeps,
): BrowserHost {
  const tabs: Tab[] = []
  const recentlyClosed: ClosedTab[] = []
  const picker: Picker = createPicker()
  let activeTabId: number | null = null
  let nextId = 0
  let revision = 0
  let bounds: Rectangle = { x: 0, y: 0, width: 1, height: 1 }
  let visible = false

  const find = (id: number): Tab | undefined => tabs.find((tab) => tab.id === id)

  /** 当前该显示哪一页：只有活动标签，且它真的导航过（空白标签没有要显示的东西）。 */
  const showing = (): Tab | undefined => {
    const tab = activeTabId === null ? undefined : find(activeTabId)

    return tab?.url === null ? undefined : tab
  }

  function read(): BrowserState {
    return {
      revision,
      tabs: tabs.map((tab) => ({
        id: tab.id,
        url: tab.url,
        title: tab.title,
        loading: tab.loading,
        // 图标原来由 reqwest 取回压成 data:；渲染层还没有消费者，先不假装有。
        favicon: null,
      })),
      activeTabId,
      pickingTabId: picker.activeTabId(),
      recentlyClosed: [...recentlyClosed],
    }
  }

  function publish(): BrowserState {
    revision += 1

    const state = read()

    onStateChanged(state)

    return state
  }

  /** 摆放只有这一处：活动标签贴着面板矩形，其余一律不画。窗口 resize 也走它。 */
  function layout(): void {
    const target = showing()

    for (const tab of tabs) {
      const shown = visible && tab === target

      tab.view.setVisible(shown)

      if (shown) {
        tab.view.setBounds({
          x: Math.round(bounds.x),
          y: Math.round(bounds.y),
          // 内核不接受零尺寸：面板收起/极窄时至少留一像素。
          width: Math.max(1, Math.round(bounds.width)),
          height: Math.max(1, Math.round(bounds.height)),
        })
      }
    }
  }

  function noteUrl(id: number, url: string): void {
    const tab = find(id)

    if (tab === undefined) {
      return
    }

    tab.url = url === BLANK_PAGE ? null : url
    publish()
  }

  function setLoading(id: number, loading: boolean): void {
    const tab = find(id)

    if (tab === undefined || tab.loading === loading) {
      return
    }

    tab.loading = loading
    publish()
  }

  function inject(id: number, code: string): void {
    const tab = find(id)

    if (tab === undefined) {
      return
    }

    tab.view.webContents
      .executeJavaScriptInIsolatedWorld(PICKER_WORLD, [{ code }])
      .catch((cause: unknown) => {
        console.warn(`browser: 标签 ${id} 拒绝了注入脚本 ${String(cause)}`)
      })
  }

  /** 停掉某标签（或任意标签）正在进行的拾取；真的停掉了一个才回 true。 */
  function stopPicker(id: number | null): boolean {
    const lease = id === null ? picker.cancelActive() : picker.cancel(id)

    if (lease === null) {
      return false
    }

    inject(lease.tabId, PICKER_CANCEL_SCRIPT)

    return true
  }

  /** 换标签时停掉别人身上的拾取；同一个标签继续拾取则不受影响。 */
  function stopPickerUnless(id: number): void {
    const active = picker.activeTabId()

    if (active !== null && active !== id) {
      stopPicker(null)
    }
  }

  function finishPick(id: number, outcome: PickOutcome): void {
    if (!picker.finish(id, outcome.token)) {
      // 旧面板晚一步回话：这份载荷属于上一次拾取，收下就是串台。
      console.warn(`browser: 标签 ${id} 回了一个过期的拾取载荷`)
      return
    }

    if (outcome.kind === 'submitted') {
      deps.onElementPicked({
        tabId: id,
        submission: outcome.submission,
        elementType: outcome.element.elementType,
        comment: outcome.element.comment,
        reportPath: writeElementReport(outcome.element.report),
      })
    }

    publish()
  }

  function createView(id: number): WebContentsView {
    const view = new WebContentsView({
      webPreferences: {
        partition: BROWSER_PARTITION,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
      },
    })

    const contents = view.webContents

    // 外站不许开自己的窗口：http(s) 交给宿主开一个新标签（原来的 on_new_window），其余直接丢。
    contents.setWindowOpenHandler(({ url }) => {
      if (isWebAddress(url)) {
        stopPicker(null)
        openTab(url)
      } else {
        console.warn(`browser: 拒绝打开非 web 地址 ${url}`)
      }

      return { action: 'deny' }
    })

    contents.on('will-navigate', (event, url) => {
      // 拾取面板的回调不是一次导航，是它把结果送回来的唯一一条路：拦住、收下、不跳。
      if (isPickerCallback(url)) {
        event.preventDefault()

        const outcome = decodePickerCallback(url)

        if (outcome === null) {
          console.warn(`browser: 标签 ${id} 回了一个认不出的拾取载荷`)

          return
        }

        finishPick(id, outcome)

        return
      }

      if (!isWebAddress(url)) {
        event.preventDefault()
      }
    })

    contents.on('did-navigate', (_event, url) => {
      noteUrl(id, url)
    })

    contents.on('did-navigate-in-page', (_event, url) => {
      noteUrl(id, url)
    })

    contents.on('page-title-updated', (_event, title) => {
      const tab = find(id)

      if (tab !== undefined && title.length > 0) {
        tab.title = title
        publish()
      }
    })

    contents.on('did-start-loading', () => {
      setLoading(id, true)
    })

    contents.on('did-stop-loading', () => {
      setLoading(id, false)
    })

    win.contentView.addChildView(view)
    view.setVisible(false)

    return view
  }

  function openTab(url?: string | null): void {
    stopPicker(null)

    const normalized = url === undefined || url === null ? null : normalizeAddress(url)

    if (url !== undefined && url !== null && normalized === null) {
      console.warn(`browser: 拒绝打开无法归一化的地址 ${url}`)

      return
    }

    const id = nextId

    nextId += 1

    const tab: Tab = {
      id,
      url: normalized,
      title: normalized === null ? '新标签页' : displayHost(normalized),
      loading: normalized !== null,
      view: createView(id),
    }

    tabs.push(tab)
    activeTabId = id

    if (normalized !== null) {
      void tab.view.webContents.loadURL(normalized).catch((cause: unknown) => {
        console.warn(`browser: 标签 ${id} 装载失败 ${String(cause)}`)
      })
    }

    layout()
    publish()
  }

  function closeTab(id: number): void {
    stopPicker(id)

    const index = tabs.findIndex((tab) => tab.id === id)

    if (index === -1) {
      return
    }

    const [removed] = tabs.splice(index, 1)

    if (removed === undefined) {
      return
    }

    if (removed.url !== null) {
      if (recentlyClosed.length === RECENTLY_CLOSED_CAP) {
        recentlyClosed.pop()
      }

      recentlyClosed.unshift({ url: removed.url, title: removed.title })
    }

    if (activeTabId === id) {
      // 先右后左：与 crates/browser 的 close 同一套落点，关掉最右一页时焦点才回到左边那页。
      const next = tabs[index] ?? tabs[index - 1]

      activeTabId = next?.id ?? null
    }

    win.contentView.removeChildView(removed.view)
    removed.view.webContents.close()

    layout()
    publish()
  }

  function drive(id: number, address: string): void {
    const tab = find(id)

    if (tab === undefined) {
      console.warn(`browser: 没有标签 ${id} 可以导航`)

      return
    }

    const normalized = normalizeAddress(address)

    if (normalized === null) {
      console.warn(`browser: 拒绝导航到 ${address}`)

      return
    }

    tab.url = normalized
    tab.title = displayHost(normalized)
    tab.loading = true

    void tab.view.webContents.loadURL(normalized).catch((cause: unknown) => {
      console.warn(`browser: 标签 ${id} 装载失败 ${String(cause)}`)
    })

    layout()
    publish()
  }

  return {
    state: read,

    openTab,

    closeTab,

    selectTab(id) {
      if (find(id) === undefined) {
        return
      }

      stopPickerUnless(id)
      activeTabId = id
      layout()
      publish()
    },

    navigate(id, address) {
      stopPicker(id)
      drive(id, address)
    },

    back(id) {
      stopPicker(id)

      const tab = find(id)

      if (tab === undefined) {
        return
      }

      if (tab.view.webContents.navigationHistory.canGoBack()) {
        tab.view.webContents.navigationHistory.goBack()
      }

      layout()
      publish()
    },

    forward(id) {
      stopPicker(id)

      const tab = find(id)

      if (tab === undefined) {
        return
      }

      if (tab.view.webContents.navigationHistory.canGoForward()) {
        tab.view.webContents.navigationHistory.goForward()
      }

      layout()
      publish()
    },

    reload(id) {
      stopPicker(id)

      const tab = find(id)

      if (tab === undefined) {
        return
      }

      tab.view.webContents.reload()
      layout()
      publish()
    },

    print(id) {
      const tab = find(id)

      if (tab === undefined) {
        return
      }

      // 用内核自己的打印，而不是往页面里 eval window.print()：页面换了 print 处理就走样，CSP 也可能挡住注入。
      tab.view.webContents.print({}, (success, reason) => {
        if (!success) {
          console.warn(`browser: 打印未完成 ${reason}`)
        }
      })
    },

    reopenClosed(index) {
      stopPicker(null)

      const [record] = recentlyClosed.splice(index, 1)

      if (record === undefined) {
        return
      }

      openTab(record.url)
    },

    setBounds(rect) {
      bounds = rect
      layout()
    },

    relayout() {
      layout()
    },

    setVisible(next) {
      if (!next) {
        stopPicker(null)
      }

      visible = next
      layout()
    },

    setElementPicker(id, enabled, theme) {
      const tab = find(id)

      if (tab === undefined) {
        return
      }

      if (!enabled) {
        if (stopPicker(id)) {
          publish()
        }

        return
      }

      // 同时只租给一个标签：换标签拾取要先退掉上一个的面板，否则两套面板会各回各的载荷。
      const previous = picker.cancelActive()

      if (previous !== null) {
        inject(previous.tabId, PICKER_CANCEL_SCRIPT)
      }

      const script = loadPickerScript()

      if (script === null) {
        console.warn('browser: 拾取脚本没打出来，这一轮拾取起不来')

        return
      }

      const lease = picker.start(id)

      inject(id, script)
      inject(id, pickerStartScript(lease, theme))
      publish()
    },

    dispose() {
      stopPicker(null)

      for (const tab of tabs) {
        win.contentView.removeChildView(tab.view)
        tab.view.webContents.close()
      }

      tabs.length = 0
      recentlyClosed.length = 0
      activeTabId = null
    },
  }
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function asArgs(args: unknown): Record<string, unknown> {
  return typeof args === 'object' && args !== null && !Array.isArray(args)
    ? (args as Record<string, unknown>)
    : {}
}

export type BrowserCommandResult = { handled: true; value: unknown } | { handled: false }

/** 只要一个标签 id 的那几条：一张表比十四个 case 短，也不会漏掉「id 不是数字就不动手」。 */
const TAB_COMMANDS: Record<string, (host: BrowserHost, id: number) => void> = {
  browser_close_tab: (host, id) => host.closeTab(id),
  browser_select_tab: (host, id) => host.selectTab(id),
  browser_back: (host, id) => host.back(id),
  browser_forward: (host, id) => host.forward(id),
  browser_reload: (host, id) => host.reload(id),
  browser_print: (host, id) => host.print(id),
}

function rectangleOf(values: Record<string, unknown>): Rectangle | null {
  const x = asNumber(values['x'])
  const y = asNumber(values['y'])
  const width = asNumber(values['width'])
  const height = asNumber(values['height'])

  return x !== null && y !== null && width !== null && height !== null
    ? { x, y, width, height }
    : null
}

/**
 * 渲染层的 browser_* 命令落到宿主上的唯一一处（命令名与生成物一致，参数键是 snake_case 线上名）。
 * 认不出的命令交回主进程走原生：这里不是第二张命令表，只是宿主要自己答的那几条。
 */
export function applyBrowserCommand(
  host: BrowserHost,
  command: string,
  args: unknown,
): BrowserCommandResult {
  const values = asArgs(args)
  const id = asNumber(values['id'])

  switch (command) {
    case 'browser_state':
      return { handled: true, value: host.state() }

    case 'browser_open_tab': {
      const url = values['url']

      host.openTab(typeof url === 'string' ? url : null)

      return { handled: true, value: null }
    }

    case 'browser_navigate': {
      const address = values['address']

      if (id !== null && typeof address === 'string') {
        host.navigate(id, address)
      }

      return { handled: true, value: null }
    }

    case 'browser_reopen_closed': {
      const index = asNumber(values['index'])

      if (index !== null) {
        host.reopenClosed(index)
      }

      return { handled: true, value: null }
    }

    case 'browser_set_bounds': {
      const rectangle = rectangleOf(values)

      if (rectangle !== null) {
        host.setBounds(rectangle)
      }

      return { handled: true, value: null }
    }

    case 'browser_set_visible':
      host.setVisible(values['visible'] === true)

      return { handled: true, value: null }

    case 'browser_set_element_picker':
      if (id !== null) {
        host.setElementPicker(
          id,
          values['enabled'] === true,
          values['theme'] === 'dark' ? 'dark' : 'light',
        )
      }

      return { handled: true, value: null }

    default:
      break
  }

  const action = TAB_COMMANDS[command]

  if (action === undefined) {
    return { handled: false }
  }

  if (id !== null) {
    action(host, id)
  }

  return { handled: true, value: null }
}
