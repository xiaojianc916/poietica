import { AppError, type Clock, type Disposable, type Logger, systemClock, toDisposable } from '@poietica/foundation'
import type { BrowserState } from '../contract/entities'
import { BLANK_PAGE, BROWSER_PARTITION } from '../contract/entities'
import { browserErrors } from '../contract/errors'
import type { RelayInbound, RelayOutbound, TabSnapshot } from './relay-protocol'
import type { WebContentsLike } from './tabs'

/*
 * 内置浏览器接进 agent 的那条线（07 页 §12D「relay 通道」）。**迁移自** legacy
 * `apps/desktop/electron/browser/relay.ts`，全部语义照旧，只换两处口径：
 *
 *   - electron 的三个 API（session/WebContents/WebSocket）都从外面注入：
 *     `createSocket` 与 `RelayTabsPort.userAgent()` 由 index.ts 用真实对象实现，
 *     测试喂假 socket / 假 contents 就能钉住 BR-2…BR-7；
 *   - 连接由 setUrl 驱动（原来只有 start/stop）：Core 每次重启端口都可能变。
 *
 * 不走「开应用级 remote-debugging-port 再把 cdpUrl 指过去」：那个端点上主界面自己也是
 * 一个 page target，omp 挑 target 时 agent 会一头钻进主界面；而且整个应用的调试面就此
 * 开在回环上，本机任何进程都能连。
 */

export const DEFAULT_RELAY_URL = 'http://127.0.0.1:9224'

const RECONNECT_MIN_MS = 1000
const RECONNECT_MAX_MS = 10000
/** 与扩展同款心跳：对面 30s 一轮的保活要有东西可听。 */
const PING_INTERVAL_MS = 20000

/** WebSocket 里用到的那一份子集（测试的假 socket 也满足它）。 */
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
  /** session.fromPartition(BROWSER_PARTITION).getUserAgent() */
  userAgent(): string
  /** `Chrome/${process.versions.chrome}` */
  browserVersion(): string
}

export interface RelayClient {
  /** 设置 relay 地址并（重新）开始连接；null = 停止连接 */
  setUrl(url: string | null): void
  /** 标签面变化：按 tabCreated / tabUpdated / tabRemoved 推送差异 */
  publish(state: BrowserState): void
  readonly connected: () => boolean
  onConnectedChange(listener: (connected: boolean) => void): Disposable
  dispose(): void
}

/**
 * Core 状态 → relay 地址（07 页 §12D 装配节选；BR-11 钉的就是这条映射）。
 *
 * relay 服务只在 omp 第一次使用浏览器工具时才启动，所以「连不上」是常态；
 * Core 每次重启端口都可能变，`restarting` 期间必须先把地址收掉（null）。
 */
export function relayUrlForStatus(state: string, port: number | null): string | null {
  return state === 'ready' && port !== null ? `http://127.0.0.1:${String(port)}` : null
}

export interface RelayClientOptions {
  readonly logger: Logger
  readonly createSocket?: (url: string) => RelaySocket
  readonly clock?: Clock
  /** 每次 Host 启动生成一次（`poietica-<UUID>`）；不传时随机造一个，测试可固定。 */
  readonly instanceId?: string
}

const SOCKET_OPEN = 1

export function createRelayClient(tabs: RelayTabsPort, opts: RelayClientOptions): RelayClient {
  const clock = opts.clock ?? systemClock
  const connect = opts.createSocket ?? defaultCreateSocket
  /*
   * 这一侧的浏览器身份：relay 按它给标签分命名空间。relay 对同名实例是「最新连接顶掉旧连接」，
   * 固定 id 会被别的连接挤出 CDP 发现。每次启动换一个 —— 重启后的标签 id 从 1 数起，
   * 换命名空间才不会撞上上一次运行留下的状态。
   */
  const instanceId = opts.instanceId ?? `poietica-${crypto.randomUUID()}`

  let url: string | null = null
  let socket: RelaySocket | null = null
  let reconnectDelay = RECONNECT_MIN_MS
  let reconnectTimer: Disposable | null = null
  let pingTimer: Disposable | null = null
  let disposed = false
  let isConnected = false
  /** 上一次报给 relay 的标签面，用来算增删改。 */
  const known = new Map<number, TabSnapshot>()
  /*
   * 正在由我们主动 detach 的标签：它的 detached 回执不算「用户拆掉了调试器」。
   * 这个标记要留到下一次 attach 才清 —— 内核为一轮 detach 会发不止一条 detach 事件，
   * 后面的每一条若被读成「用户拆的」，relay 就把这张标签拉黑（banned）。
   */
  const detaching = new Set<number>()
  /** 已经挂过监听的内核对象。监听按 WebContents 挂，多挂一条就多一条假回执。 */
  const wired = new WeakSet<WebContentsLike>()
  const listeners = new Set<(connected: boolean) => void>()

  /*
   * 端点：`http://127.0.0.1:<port>` → `ws://127.0.0.1:<port>/ext`。
   * WebSocket 构造函数只认 ws/wss，直接把 http 地址喂给它是一句 SyntaxError
   * （连不上而且看不出原因），所以换算必须在这里做。
   */
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

  /** 把标签面折成 relay 的 TabSnapshot：面板里没有标签组，windowId/pinned/groupId 是常量。 */
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

  /*
   * CDP 要有一张已经提交的文档：没导航过的内核里没有 DevTools 会话，命令发下去
   * Electron 既不回执也不报错，relay 那边只会等到 20s 超时。空白标签（宿主记
   * 「没有 url」）就是这样 —— 补一张 about:blank，内核报回来的地址会被宿主的
   * noteUrl 归回「没有 url」，面板不见变化。
   */
  async function ensureDocument(contents: WebContentsLike): Promise<void> {
    if (contents.getURL().length === 0 && !contents.isLoading()) {
      await contents.loadURL(BLANK_PAGE)
    }
  }

  function reportDetach(tabId: number, reason: string): void {
    post({ t: 'detached', tabId, reason, relayInitiated: detaching.has(tabId) })
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
        reportDetach(tabId, String(reason))
      })
    }

    if (!debugger_.isAttached()) {
      debugger_.attach('1.3')
    }

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

        /* sessionId 是 relay 给的真实子会话（OOPIF、worker）：Electron 认同一套，直接转过去。 */
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

  /*
   * 握手：报上当前标签面。一个标签都没有就先开一个 —— relay 服务端活着就是 agent
   * 要用浏览器了，而 CDP 上一个 page target 都没有时它只会答「没有可用页面」。
   */
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
      pingTimer?.dispose()
      pingTimer = null
      scheduleReconnect()
    })

    next.addEventListener('error', () => {
      next.close()
    })
  }

  /*
   * 标签面的增删改。不整份重发：relay 那边按 tabId 维护状态，重发会让它把每个标签
   * 当成新出现的（它据此决定要不要给下游发 targetCreated）。
   */
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

    dispose() {
      disposed = true
      reconnectTimer?.dispose()
      reconnectTimer = null
      closeSocket()
      listeners.clear()
    },
  }
}

/**
 * 默认的 socket 工厂。relay 的默认端点（DEFAULT_RELAY_URL）只在没有 Core 端口时留着给
 * 开发期直连；生产路径上 Host 每次用 supervisor.relayPort() 传给 setUrl。
 */
function defaultCreateSocket(target: string): RelaySocket {
  return new WebSocket(target) as unknown as RelaySocket
}

/** relay 地址 → WebSocket 地址（http → ws、https → wss）。 */
export function relaySocketUrl(base: string): string {
  const endpoint = `${base.replace(/\/+$/, '')}/ext`

  return endpoint.replace(/^http/, 'ws')
}

export { BROWSER_PARTITION }
