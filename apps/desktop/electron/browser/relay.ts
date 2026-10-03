/*
 * 内置浏览器接进 agent 的那条线：把面板里的标签当作一台"现成的浏览器"端出去。
 *
 * omp 的浏览器工具有三条档：自己拉一个 Chromium、附着到现成 CDP、以及 relay。relay 是
 * 它留给"驱动用户自己的浏览器标签页"的口子：本机一个 HTTP + WS 服务（/json/version、
 * /cdp、/ext）冒充 Chrome 的 CDP 发现端点，另一头本该由浏览器扩展拨进来 —— 我们不用
 * 扩展：主进程手上有 webContents.debugger，与扩展用的 chrome.debugger 是同一套东西，
 * 于是这一侧由主进程自己扮演。omp 看到的是一台普通浏览器，实际动的是面板里的
 * WebContentsView。
 *
 * 不走"开应用级 remote-debugging-port 再把 cdpUrl 指过去"：那个端点上主界面自己也是
 * 一个 page target，而 omp 挑 target 的判据是"可见的、或枚举到的第一个"
 * （tools/browser/attach.ts 的 pickElectronTarget），agent 会一头钻进主界面；而且整个
 * 应用的调试面就此开在回环上，本机任何进程都能连。
 *
 * 线上形状的正本是 omp 自己的 tools/browser/relay/protocol.ts（锚定 18.5.0）：那是它
 * 内部的契约，没有版本号，所以这里与它逐字对应，升级 omp 时一起核。
 */
import { randomUUID } from 'node:crypto'

import { session, type WebContents } from 'electron'

import { BLANK_PAGE, BROWSER_PARTITION, type BrowserHost, type BrowserState } from './host'

/** omp relay 的默认端点，与它的 tools/browser/relay/kind.ts 的 DEFAULT_RELAY_URL 同值。 */
export const DEFAULT_RELAY_URL = 'http://127.0.0.1:9224'

/*
 * 这一侧的浏览器身份：relay 按它给标签分命名空间。不带它就落进「anon」那一档 ——
 * relay 对同名实例是「最新连接顶掉旧连接」，任何另一个 /ext 连接（另开一个 Poietica、
 * 或别人写的探针）都能把面板的标签从 CDP 发现里清掉，而这条 TCP 还挂着 ESTABLISHED，
 * 看起来一切正常。每次启动换一个：重启后的标签 id 从 0 数起，换命名空间才不会撞上
 * 上一次运行留下的状态（banned / attached / 子会话）。
 */
const INSTANCE_ID = `poietica-${randomUUID()}`

const RECONNECT_MIN_MS = 1000
const RECONNECT_MAX_MS = 10000
/** 与扩展同款心跳：对面 30s 一轮的保活要有东西可听。 */
const PING_INTERVAL_MS = 20000

/** 报给 relay 的一个标签，字段与它的 relay/protocol.ts 的 TabSnapshot 逐字相同。 */
interface TabSnapshot {
  tabId: number
  url: string
  title: string
  active: boolean
  windowId: number
  pinned: boolean
  groupId: number
}

/** relay 要扩展做的那些事，与它的 RelayRpcRequest 逐字相同。 */
type RelayRpc =
  | { op: 'attach'; tabId: number }
  | { op: 'detach'; tabId: number }
  | {
      op: 'send'
      tabId: number
      sessionId?: string
      method: string
      params?: Record<string, unknown>
    }
  | { op: 'createTab'; url: string }
  | { op: 'removeTab'; tabId: number }
  | { op: 'activateTab'; tabId: number }
  | { op: 'group'; tabIds: number[]; title: string; color: string }
  | { op: 'ungroup'; tabIds: number[] }

type RelayMessage = ({ t: 'rpc'; id: number } & RelayRpc) | { t: 'pong' }

export interface BrowserRelayOptions {
  /** omp relay 的 HTTP 端点；拨的是它的 /ext。 */
  readonly url: string
  /**
   * 接上了、agent 要开始用内置浏览器了。面板据此展开并切到浏览器那一段 —— 用户看得见
   * AI 正在动哪个页面。
   *
   * 判据是"relay 服务端在"：那个服务是 omp 自己的浏览器前奏要用时才拉起来的，所以它
   * 活着就等于 agent 正要动浏览器，而不是"应用启动了"。
   */
  readonly onDriven: () => void
}

export interface BrowserRelay {
  start(): void
  stop(): void
  /** 标签面变了：把增删改推给 relay（它据此维护 Target 列表）。 */
  publish(state: BrowserState | null): void
}

export function createBrowserRelay(host: BrowserHost, options: BrowserRelayOptions): BrowserRelay {
  let socket: WebSocket | null = null
  let reconnectTimer: NodeJS.Timeout | null = null
  let pingTimer: NodeJS.Timeout | null = null
  let reconnectDelay = RECONNECT_MIN_MS
  let stopped = false
  /** 上一次报给 relay 的标签面，用来算增删改。 */
  const known = new Map<number, TabSnapshot>()
  /**
   * 正在由我们主动 detach 的标签：它的 detached 回执不算"用户拆掉了调试器"。
   *
   * 这个标记要留到下一次 attach 才清，不能在第一条回执里就消费掉 —— 内核为一轮
   * detach 会发不止一条 detach 事件，后面的每一条都会被读成"用户主动拆的"，
   * relay 据此把这张标签拉黑（banned），面板的页面从 CDP 发现里消失，之后每次
   * browser.open 都只会得到「没有可用页面」，直到这一页换了地址。
   */
  const detaching = new Set<number>()
  /** 已经挂过监听的内核对象。监听按 WebContents 挂，多挂一条就多一条假回执。 */
  const wired = new WeakSet<WebContents>()

  const endpoint = (): string => `${options.url.replace(/\/+$/, '')}/ext`

  function post(message: unknown): void {
    if (socket !== null && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(message))
    }
  }

  /** 把超长地址截短：标签面是状态通报，不是正文。 */
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
   * noteUrl 归回「没有 url」，面板不见变化。isLoading 那半是护栏：正在导航的
   * 标签不能被打断，而待提交的导航已经收得下命令。
   */
  async function ensureDocument(contents: WebContents): Promise<void> {
    if (contents.getURL().length === 0 && !contents.isLoading()) {
      await contents.loadURL(BLANK_PAGE)
    }
  }

  /*
   * 一个标签的内核调试面。
   *
   * 一次 attach 就够：omp 的标签监管、每个标签的 worker 都从同一个 relay 端点连进来，
   * 由 relay 那边复用（它自己按 tab 维护唯一一条 chrome.debugger 挂载）。事件按标签
   * 转给 relay，它再分发给各自的下游会话。
   */
  async function attachDebugger(tabId: number): Promise<WebContents> {
    const contents = host.contentsOf(tabId)

    if (contents === null) {
      throw new Error(`没有标签 ${String(tabId)} 可以附着`)
    }

    await ensureDocument(contents)

    detaching.delete(tabId)

    const debugger_ = contents.debugger

    if (!wired.has(contents)) {
      wired.add(contents)
      debugger_.on('message', (_event, method, params, sessionId) => {
        post({ t: 'cdpEvent', tabId, sessionId, method, params })
      })
      debugger_.on('detach', (_event, reason) => {
        post({ t: 'detached', tabId, reason, relayInitiated: detaching.has(tabId) })
      })
    }

    if (!debugger_.isAttached()) {
      debugger_.attach('1.3')
    }

    return contents
  }

  async function runRpc(message: RelayMessage & { t: 'rpc' }): Promise<unknown> {
    switch (message.op) {
      case 'attach': {
        await attachDebugger(message.tabId)

        return {}
      }
      case 'detach': {
        const contents = host.contentsOf(message.tabId)

        if (contents?.debugger.isAttached() === true) {
          detaching.add(message.tabId)
          contents.debugger.detach()
        }

        return {}
      }
      case 'send': {
        const contents = await attachDebugger(message.tabId)

        /*
         * sessionId 是 relay 给的**真实**子会话（OOPIF、worker）：它自己的伪会话在
         * 转发前就剥掉了。Electron 的 sendCommand 认同一套 sessionId，直接转过去。
         */
        return await contents.debugger.sendCommand(
          message.method,
          message.params ?? {},
          message.sessionId,
        )
      }
      case 'createTab': {
        // omp 的 newPage 用 about:blank 要一个空白标签：那是「没有 url」，不是地址。
        const id = host.openTab(message.url === BLANK_PAGE ? null : message.url)

        if (id === null) {
          throw new Error(`打不开这个地址：${message.url}`)
        }

        return { tab: snapshotOf(host.state()).find((tab) => tab.tabId === id) }
      }
      case 'removeTab': {
        host.closeTab(message.tabId)

        return {}
      }
      case 'activateTab': {
        host.selectTab(message.tabId)

        return {}
      }
      /*
       * 分组是 Chrome 的标签组，面板里没有对应物：认下这两条，什么都不做。
       * 它们只影响 Chrome 自己的界面，agent 侧的语义（谁在被驱动）不靠它。
       */
      case 'group':
      case 'ungroup':
        return {}
    }
  }

  function handle(raw: string): void {
    let message: RelayMessage

    try {
      message = JSON.parse(raw) as RelayMessage
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
          error: cause instanceof Error ? cause.message : String(cause),
        })
      },
    )
  }

  /*
   * 握手：报上当前标签面。
   *
   * 一个标签都没有就先开一个 —— relay 服务端活着就是 agent 要用浏览器了，而 CDP 上
   * 一个 page target 都没有时它只会答"没有可用页面"。用户不必自己去点开面板。
   */
  function hello(): void {
    if (host.state().tabs.length === 0) {
      host.openTab(null)
    }

    const tabs = snapshotOf(host.state())

    for (const tab of tabs) {
      known.set(tab.tabId, tab)
    }

    post({
      t: 'hello',
      instanceId: INSTANCE_ID,
      userAgent: userAgent(),
      browserVersion: `Chrome/${process.versions.chrome ?? '0'}`,
      tabs,
      attachedTabIds: [],
    })
  }

  /*
   * 报给 relay 的浏览器身份取内核自己的 UA。主进程的 navigator 是 Node 的
   * （userAgent 就是 "Node.js/24"），omp 拿它当浏览器 UA 去覆盖页面，站点看到的
   * 就是这个假身份，与它同时收到的 Chrome 版本自相矛盾。
   *
   * 问分区会话而不是某个标签：会话是浏览器身份的所有者，没有标签时也有答案。
   */
  function userAgent(): string {
    return session.fromPartition(BROWSER_PARTITION).getUserAgent()
  }

  function scheduleReconnect(): void {
    if (stopped || reconnectTimer !== null) {
      return
    }

    const delay = reconnectDelay

    reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS)
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      connect()
    }, delay)
  }

  function connect(): void {
    if (stopped || socket !== null) {
      return
    }

    let next: WebSocket

    try {
      next = new WebSocket(endpoint())
    } catch (cause) {
      console.warn(`browser: 连不上 relay ${endpoint()} ${String(cause)}`)
      scheduleReconnect()

      return
    }

    socket = next

    next.addEventListener('open', () => {
      reconnectDelay = RECONNECT_MIN_MS
      hello()
      options.onDriven()
      pingTimer = setInterval(() => {
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

      if (pingTimer !== null) {
        clearInterval(pingTimer)
        pingTimer = null
      }

      scheduleReconnect()
    })

    next.addEventListener('error', () => {
      next.close()
    })
  }

  /*
   * 标签面的增删改。
   *
   * 不整份重发：relay 那边按 tabId 维护状态，重发会让它把每个标签当成新出现的
   * （它据此决定要不要给下游发 targetCreated）。所以这里与它的
   * tabCreated / tabUpdated / tabRemoved 三条一一对应。
   */
  function publishDiffs(state: BrowserState | null): void {
    if (state === null || socket === null || socket.readyState !== WebSocket.OPEN) {
      return
    }

    const next = new Map<number, TabSnapshot>()

    for (const tab of snapshotOf(state)) {
      next.set(tab.tabId, tab)

      const before = known.get(tab.tabId)

      if (before === undefined) {
        post({ t: 'tabCreated', tab })
      } else if (
        before.url !== tab.url ||
        before.title !== tab.title ||
        before.active !== tab.active
      ) {
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

  return {
    start(): void {
      if (stopped) {
        return
      }

      connect()
    },

    stop(): void {
      stopped = true

      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer)
        reconnectTimer = null
      }

      if (pingTimer !== null) {
        clearInterval(pingTimer)
        pingTimer = null
      }

      socket?.close()
      socket = null
      known.clear()
    },

    publish: publishDiffs,
  }
}
