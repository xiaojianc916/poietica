import { AppError, type Clock, type Disposable, type Logger, systemClock, toDisposable } from '@poietica/foundation'
import type { BrowserState } from '../contract/entities'
import { BLANK_PAGE, BROWSER_PARTITION } from '../contract/entities'
import { browserErrors } from '../contract/errors'
import type { RelayInbound, RelayOutbound, TabSnapshot } from './relay-protocol'
import type { WebContentsLike } from './tabs'

/* 内置浏览器接进 agent 的那条线（relay 通道）。electron 的 API 全部注入：createSocket 与
 * RelayTabsPort.userAgent() 由 index.ts 用真实对象实现，测试喂假 socket 就能钉住 BR-2…BR-7；连接由 setUrl
 * 驱动（Core 每次重启端口都可能变）。不走「开应用级 remote-debugging-port 再把 cdpUrl 指过去」：那个端点上
 * 主界面自己也是一个 page target，agent 挑 target 会钻进主界面，而且整个应用的调试面就此开在回环上。 */

export const DEFAULT_RELAY_URL = 'http://127.0.0.1:9224'

const RECONNECT_MIN_MS = 1000
const RECONNECT_MAX_MS = 10000
/** 与扩展同款心跳：对面 30s 一轮的保活要有东西可听。 */
const PING_INTERVAL_MS = 20000

export interface RelaySocket {
  readonly readyState: number
  send(data: string): void
  close(): void
  addEventListener(type: 'open', listener: () => void): void
  addEventListener(type: 'close', listener: () => void): void
  addEventListener(type: 'error', listener: () => void): void
  addEventListener(type: 'message', listener: (event: { readonly data: unknown }) => void): void
}

export interface RelayTabsPort {
  state(): BrowserState
  contentsOf(tabId: number): WebContentsLike | null
  openTab(url: string | null): number | null
  closeTab(tabId: number): void
  selectTab(tabId: number): void
  userAgent(): string
  browserVersion(): string
}

export interface RelayClient {
  /** 设置 relay 地址并（重新）开始连接；null = 停止连接 */
  setUrl(url: string | null): void
  publish(state: BrowserState): void
  readonly connected: () => boolean
  onConnectedChange(listener: (connected: boolean) => void): Disposable
  /** 挂着 AI 调试器的标签集合变了（B-04）；只报变化，不报初始值。 */
  onAttachedChange(listener: (attachedTabIds: readonly number[]) => void): Disposable
  dispose(): void
}

/** restarting 期间必须先收掉地址：Core 每次重启端口都可能变（BR-11）。 */
export function relayUrlForStatus(state: string, port: number | null): string | null {
  return state === 'ready' && port !== null ? `http://127.0.0.1:${String(port)}` : null
}

export interface RelayClientOptions {
  readonly logger: Logger
  readonly createSocket?: (url: string) => RelaySocket
  readonly clock?: Clock
  readonly instanceId?: string
}

const SOCKET_OPEN = 1

export function createRelayClient(tabs: RelayTabsPort, opts: RelayClientOptions): RelayClient {
  const clock = opts.clock ?? systemClock
  const connect = opts.createSocket ?? defaultCreateSocket
  /* 浏览器身份：relay 按它给标签分命名空间，同名实例是「最新连接顶掉旧连接」—— 固定 id 会被别的连接挤出 CDP 发现，所以每次启动换一个。 */
  const instanceId = opts.instanceId ?? `poietica-${crypto.randomUUID()}`

  let url: string | null = null
  let socket: RelaySocket | null = null
  let reconnectDelay = RECONNECT_MIN_MS
  let reconnectTimer: Disposable | null = null
  let pingTimer: Disposable | null = null
  let disposed = false
  let isConnected = false
  const known = new Map<number, TabSnapshot>()
  /* 正在由我们主动 detach 的标签：它的 detached 回执不算「用户拆掉了调试器」。标记要留到下一次 attach ——
   * 内核为一轮 detach 会发不止一条事件，后面每条若被读成「用户拆的」，relay 就把这张标签拉黑。 */
  const detaching = new Set<number>()
  /** 监听按 WebContents 挂，多挂一条就多一条假回执。 */
  const wired = new WeakSet<WebContentsLike>()
  /** 当前被我们关掉后台节流的标签（B-03）：重复 attach 不重复下发，分离时恢复一次。 */
  const unthrottled = new Set<WebContentsLike>()
  /* 挂着 AI 调试器的标签（B-04）：「AI 正在使用这个浏览器」说的是这个集合非空，不是 socket 连着。
   * 三处删除路径：debugger 的 detach 回执、显式 detach 的那条 rpc、socket 关闭时清空。 */
  const attached = new Set<number>()
  const listeners = new Set<(connected: boolean) => void>()
  const attachedListeners = new Set<(attachedTabIds: readonly number[]) => void>()

  /* 端点 http://… → ws://…/ext：WebSocket 构造函数只认 ws/wss，直接把 http 地址喂给它是一句 SyntaxError。 */
  const endpoint = (): string => relaySocketUrl(url ?? '')

  function post(message: RelayOutbound): void {
    if (socket !== null && socket.readyState === SOCKET_OPEN) {
      socket.send(JSON.stringify(message))
    }
  }

  function setConnected(next: boolean): void {
    if (isConnected === next) {
      return
    }

    isConnected = next

    for (const listener of [...listeners]) {
      listener(next)
    }
  }

  function snapshotOf(state: BrowserState): TabSnapshot[] {
    return state.tabs.map((tab) => ({
      tabId: tab.id,
      url: tab.url ?? '',
      title: tab.title,
      active: tab.id === state.activeTabId,
      windowId: 1,
      pinned: false,
      groupId: -1,
    }))
  }

  /* CDP 要有一张已经提交的文档：没导航过的内核里没有 DevTools 会话，命令发下去 Electron 既不回执也不报错，
   * relay 只会等到 20s 超时。空白标签补一张 about:blank，地址会被 noteUrl 归回「没有 url」，面板不见变化。 */
  async function ensureDocument(contents: WebContentsLike): Promise<void> {
    if (contents.getURL().length === 0 && !contents.isLoading()) {
      await contents.loadURL(BLANK_PAGE)
    }
  }

  /* 只有「用户主动拆」才该让 relay 拉黑标签：omp bridge 把 relayInitiated: false 当作用户的意思，把这张
   * 标签设为 banned 直到地址变化；而 tabs.ts 在渲染进程崩溃后按原地址重载，于是这张标签对 AI 永久不可用
   * （B-09）。Chromium 给的理由是 canceled_by_user，DevTools 抢占时带 devtools；崩溃与目标关闭都不是用户的意思。 */
  const USER_DETACH = /canceled_by_user|devtools/iu

  function reportDetach(tabId: number, reason: string): void {
    /* 真机核对理由字符串用这一条日志（B-09 的「需真机确认」）。 */
    opts.logger.info('browser debugger detached', { tabId, reason })
    post({ t: 'detached', tabId, reason, relayInitiated: detaching.has(tabId) || !USER_DETACH.test(reason) })
  }

  function markAttached(tabId: number): void {
    if (attached.has(tabId)) {
      return
    }

    attached.add(tabId)

    for (const listener of [...attachedListeners]) {
      listener([...attached])
    }
  }

  function clearAttached(): void {
    if (attached.size === 0) {
      return
    }

    attached.clear()

    for (const listener of [...attachedListeners]) {
      listener([])
    }
  }

  function markDetached(tabId: number): void {
    if (attached.delete(tabId)) {
      for (const listener of [...attachedListeners]) {
        listener([...attached])
      }
    }
  }

  /* 附着期间关掉这张标签的后台节流（B-03）：面板收起时视图是 setVisible(false)，Chromium 会把这页当后台
   * 标签降频 —— 计时器被拉长、渲染帧被跳过，Page.captureScreenshot 要么很久才回、要么根本不回。只动这一张：
   * 全局关节流会让用户自己开的后台标签一直跑满 CPU。 */
  function unthrottle(contents: WebContentsLike): void {
    if (unthrottled.has(contents)) {
      return
    }

    unthrottled.add(contents)
    contents.setBackgroundThrottling(false)
  }

  function restoreThrottling(contents: WebContentsLike): void {
    if (!unthrottled.delete(contents)) {
      return
    }

    contents.setBackgroundThrottling(true)
  }

  async function attachDebugger(tabId: number): Promise<WebContentsLike> {
    const contents = tabs.contentsOf(tabId)

    if (contents === null) {
      throw new AppError(browserErrors.relay_tab_missing, `没有标签 ${String(tabId)} 可以附着`)
    }

    await ensureDocument(contents)
    detaching.delete(tabId)

    const debugger_ = contents.debugger

    if (!wired.has(contents)) {
      wired.add(contents)
      debugger_.on('message', (_event: unknown, method: unknown, params: unknown, sessionId: unknown) => {
        post({
          t: 'cdpEvent',
          tabId,
          ...(typeof sessionId === 'string' ? { sessionId } : {}),
          method: String(method),
          params,
        })
      })
      debugger_.on('detach', (_event: unknown, reason: unknown) => {
        restoreThrottling(contents)
        markDetached(tabId)
        reportDetach(tabId, String(reason))
      })
    }

    if (!debugger_.isAttached()) {
      debugger_.attach('1.3')
    }

    unthrottle(contents)
    markAttached(tabId)

    return contents
  }

  async function runRpc(message: RelayInbound & { t: 'rpc' }): Promise<unknown> {
    switch (message.op) {
      case 'attach': {
        await attachDebugger(message.tabId)

        return {}
      }
      case 'detach': {
        const contents = tabs.contentsOf(message.tabId)

        if (contents?.debugger.isAttached() === true) {
          detaching.add(message.tabId)
          contents.debugger.detach()
        }

        return {}
      }
      case 'send': {
        const contents = await attachDebugger(message.tabId)

        return await contents.debugger.sendCommand(message.method, message.params ?? {}, message.sessionId)
      }
      case 'createTab': {
        // omp 的 newPage 用 about:blank 要一个空白标签：那是「没有 url」，不是一条地址。
        const id = tabs.openTab(message.url === BLANK_PAGE ? null : message.url)

        if (id === null) {
          throw new AppError(browserErrors.relay_address_rejected, `打不开这个地址：${message.url}`)
        }

        return { tab: snapshotOf(tabs.state()).find((tab) => tab.tabId === id) }
      }
      case 'removeTab': {
        tabs.closeTab(message.tabId)

        return {}
      }
      case 'activateTab': {
        tabs.selectTab(message.tabId)

        return {}
      }
      /* 分组是 Chrome 的标签组，面板里没有对应物：认下这两条，什么都不做。 */
      case 'group':
      case 'ungroup':
        return {}
    }
  }

  function handle(raw: string): void {
    let message: RelayInbound

    try {
      message = JSON.parse(raw) as RelayInbound
    } catch {
      return
    }

    if (message.t !== 'rpc') {
      return
    }

    const { id } = message

    void runRpc(message).then(
      (result) => {
        post({ t: 'rpcResult', id, ok: true, result: result ?? {} })
      },
      (cause: unknown) => {
        post({
          t: 'rpcResult',
          id,
          ok: false,
          error: cause instanceof AppError ? cause.message : cause instanceof Error ? cause.message : String(cause),
        })
      },
    )
  }

  /* 握手：报上当前标签面；一个标签都没有就先开一个 —— relay 服务端活着就是 agent 要用浏览器了，而 CDP 上一个 page target 都没有时它只会答「没有可用页面」。 */
  function hello(): void {
    if (tabs.state().tabs.length === 0) {
      tabs.openTab(null)
    }

    const snapshots = snapshotOf(tabs.state())

    for (const tab of snapshots) {
      known.set(tab.tabId, tab)
    }

    post({
      t: 'hello',
      instanceId,
      userAgent: tabs.userAgent(),
      browserVersion: tabs.browserVersion(),
      tabs: snapshots,
      attachedTabIds: [],
    })
  }

  function scheduleReconnect(): void {
    if (disposed || reconnectTimer !== null || url === null) {
      return
    }

    const delay = reconnectDelay

    reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS)
    reconnectTimer = clock.setTimeout(() => {
      reconnectTimer = null
      open()
    }, delay)
  }

  function open(): void {
    if (disposed || socket !== null || url === null) {
      return
    }

    let next: RelaySocket

    try {
      next = connect(endpoint())
    } catch (cause) {
      opts.logger.debug('browser relay connect failed', { endpoint: endpoint(), error: String(cause) })
      scheduleReconnect()

      return
    }

    socket = next

    next.addEventListener('open', () => {
      reconnectDelay = RECONNECT_MIN_MS
      hello()
      setConnected(true)
      pingTimer = clock.setInterval(() => {
        post({ t: 'ping' })
      }, PING_INTERVAL_MS)
    })

    next.addEventListener('message', (event) => {
      if (typeof event.data === 'string') {
        handle(event.data)
      }
    })

    next.addEventListener('close', () => {
      if (socket !== next) {
        return
      }

      socket = null
      known.clear()
      setConnected(false)
      clearAttached()
      pingTimer?.dispose()
      pingTimer = null
      scheduleReconnect()
    })

    next.addEventListener('error', () => {
      next.close()
    })
  }

  /* 标签面的增删改不整份重发：relay 按 tabId 维护状态，重发会让它把每个标签当成新出现的。 */
  function publishDiffs(state: BrowserState): void {
    if (socket === null || socket.readyState !== SOCKET_OPEN) {
      return
    }

    const next = new Map<number, TabSnapshot>()

    for (const tab of snapshotOf(state)) {
      next.set(tab.tabId, tab)

      const before = known.get(tab.tabId)

      if (before === undefined) {
        post({ t: 'tabCreated', tab })
      } else if (before.url !== tab.url || before.title !== tab.title || before.active !== tab.active) {
        post({ t: 'tabUpdated', tab })
      }
    }

    for (const tabId of known.keys()) {
      if (!next.has(tabId)) {
        post({ t: 'tabRemoved', tabId })
      }
    }

    known.clear()

    for (const [tabId, tab] of next) {
      known.set(tabId, tab)
    }
  }

  function closeSocket(): void {
    pingTimer?.dispose()
    pingTimer = null
    socket?.close()
    socket = null
    known.clear()
    setConnected(false)
    clearAttached()
  }

  return {
    setUrl(next) {
      if (disposed || url === next) {
        return
      }

      url = next
      reconnectTimer?.dispose()
      reconnectTimer = null
      reconnectDelay = RECONNECT_MIN_MS
      closeSocket()

      if (next !== null) {
        open()
      }
    },

    publish: publishDiffs,

    connected: () => isConnected,

    onConnectedChange(listener) {
      listeners.add(listener)

      return toDisposable(() => {
        listeners.delete(listener)
      })
    },

    onAttachedChange(listener) {
      attachedListeners.add(listener)

      return toDisposable(() => {
        attachedListeners.delete(listener)
      })
    },

    dispose() {
      disposed = true
      reconnectTimer?.dispose()
      reconnectTimer = null
      closeSocket()
      listeners.clear()
      attachedListeners.clear()
    },
  }
}

function defaultCreateSocket(target: string): RelaySocket {
  return new WebSocket(target) as unknown as RelaySocket
}

export function relaySocketUrl(base: string): string {
  const endpoint = `${base.replace(/\/+$/, '')}/ext`

  return endpoint.replace(/^http/, 'ws')
}

export { BROWSER_PARTITION }
