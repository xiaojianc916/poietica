import { beforeEach, describe, expect, test } from 'bun:test'
import { createTestLogger, type FakeClock, fakeClock } from '@poietica/test-kit'
import { BLANK_PAGE, type BrowserState } from '../../contract'
import { createRelayClient, type RelaySocket, type RelayTarget, relayTargetOf } from '../relay-client'

const TOKEN = 'ef'.repeat(32)
const target = (port: number): RelayTarget => ({ url: `http://127.0.0.1:${String(port)}`, token: TOKEN })

import { DISCARDED_TABS_PROTOCOL_VERSION } from '@poietica/engine'
import type { ContentsListener, WebContentsLike } from '../tabs'

/* relay 这一侧的自检：socket 与 clock 都注入，真 Chromium 与真 WebSocket 不参与；钉住 BR-2…BR-7 与 BR-11。 */

interface Sent {
  readonly t?: string
  readonly id?: number
  readonly ok?: boolean
  readonly result?: unknown
  readonly error?: string
  readonly [key: string]: unknown
}

class FakeSocket implements RelaySocket {
  static readonly OPEN = 1
  static instances: FakeSocket[] = []
  readyState = 0
  readonly url: string
  readonly sent: string[] = []
  closed = 0
  #listeners = new Map<string, ((event: unknown) => void)[]>()

  constructor(url: string) {
    this.url = url
    FakeSocket.instances.push(this)
  }

  addEventListener(type: 'open', listener: () => void): void
  addEventListener(type: 'close', listener: () => void): void
  addEventListener(type: 'error', listener: () => void): void
  addEventListener(type: 'message', listener: (event: { readonly data: unknown }) => void): void
  addEventListener(type: string, listener: ((event: { readonly data: unknown }) => void) | (() => void)): void {
    this.#listeners.set(type, [...(this.#listeners.get(type) ?? []), listener as (event: unknown) => void])
  }

  send(text: string): void {
    this.sent.push(text)
  }

  close(): void {
    this.closed += 1
    this.readyState = 3
    this.emit('close')
  }

  open(): void {
    this.readyState = FakeSocket.OPEN
    this.emit('open')
  }

  drop(): void {
    this.readyState = 3
    this.emit('close')
  }

  deliver(message: unknown): void {
    this.emit('message', { data: JSON.stringify(message) })
  }

  messages(): Sent[] {
    return this.sent.map((text) => JSON.parse(text) as Sent)
  }

  emit(type: string, event: unknown = {}): void {
    for (const listener of this.#listeners.get(type) ?? []) {
      listener(event)
    }
  }
}

type FakeDebugger = {
  isAttached: () => boolean
  attach: (protocolVersion?: string) => void
  detach: () => void
  on: (event: 'message' | 'detach', listener: ContentsListener) => void
  emit: (event: string, ...args: unknown[]) => void
  listenerCount: (event: string) => number
  sendCommand: (method: string, params?: Record<string, unknown>, sessionId?: string) => Promise<unknown>
}

interface FakeContents extends WebContentsLike {
  readonly loaded: string[]
  readonly commands: string[]
  readonly throttled: boolean[]
  readonly debugger: FakeDebugger
}

function fakeContents(url: string): FakeContents {
  const loaded: string[] = []
  const commands: string[] = []
  const throttled: boolean[] = []
  const listeners = new Map<string, ContentsListener[]>()
  let current = url
  let attached = false

  const emit = (event: string, ...args: unknown[]): void => {
    for (const listener of listeners.get(event) ?? []) {
      ;(listener as (...args: unknown[]) => void)(...args)
    }
  }

  return {
    loaded,
    commands,
    throttled,
    debugger: {
      isAttached: () => attached,
      attach: () => {
        attached = true
      },
      detach: () => {
        attached = false
        emit('detach', {}, 'target closed')
      },
      on: (event: 'message' | 'detach', listener: ContentsListener) => {
        listeners.set(event, [...(listeners.get(event) ?? []), listener])
      },
      emit,
      listenerCount: (event) => (listeners.get(event) ?? []).length,
      sendCommand: (method) => {
        commands.push(method)

        return Promise.resolve({ method })
      },
    },
    getURL: () => current,
    isLoading: () => false,
    loadURL: (next) => {
      loaded.push(next)
      current = next

      return Promise.resolve()
    },
    close: () => undefined,
    reload: () => undefined,
    stop: () => undefined,
    setZoomLevel: () => undefined,
    getZoomLevel: () => 0,
    setZoomMode: () => undefined,
    setBackgroundThrottling: (allowed) => {
      throttled.push(allowed)
    },
    executeJavaScriptInIsolatedWorld: () => Promise.resolve(undefined),
    navigationHistory: {
      canGoBack: () => false,
      canGoForward: () => false,
      goBack: () => undefined,
      goForward: () => undefined,
    },
    setWindowOpenHandler: () => undefined,
    on: () => undefined,
  }
}

interface Harness {
  readonly socket: FakeSocket
  readonly contents: FakeContents
  readonly opened: (string | null)[]
  readonly openedActive: (boolean | undefined)[]
  readonly closed: number[]
  readonly selected: number[]
  /** ensureAgentPage 被叫时标签面里有几张：0 才真的补。 */
  readonly ensured: number[]
  readonly connected: boolean[]
  readonly attachedLog: (readonly number[])[]
  readonly clock: FakeClock
  readonly log: ReturnType<typeof createTestLogger>
  readonly client: ReturnType<typeof createRelayClient>
  readonly state: BrowserState
}

function harness(
  url: string,
  createSocket: (target: string) => RelaySocket = (target) => new FakeSocket(target),
  openSocket = true,
): Harness {
  FakeSocket.instances = []

  const contents = fakeContents(url)
  const opened: (string | null)[] = []
  const openedActive: (boolean | undefined)[] = []
  const closed: number[] = []
  const selected: number[] = []
  const ensured: number[] = []
  const connected: boolean[] = []
  const attachedLog: (readonly number[])[] = []
  const clock = fakeClock()
  const log = createTestLogger()
  const state: BrowserState = {
    revision: 1,
    tabs: [
      {
        id: 1,
        url: url === '' ? null : url,
        title: 't',
        loading: false,
        favicon: null,
        canGoBack: false,
        canGoForward: false,
        zoom: 0,
      },
    ],
    activeTabId: 1,
    pickingTabId: null,
    recentlyClosed: [],
    driven: false,
  }

  const client = createRelayClient(
    {
      state: () => state,
      contentsOf: (id) => (id === 1 ? contents : null),
      openTab: (next, active) => {
        opened.push(next)
        openedActive.push(active)
        const id = state.tabs.length + 1
        const tab = {
          id,
          url: next,
          title: next ?? '新标签页',
          loading: false,
          favicon: null,
          canGoBack: false,
          canGoForward: false,
          zoom: 0,
        }

        state.tabs.push(tab)
        state.activeTabId = id

        return id
      },
      ensureAgentPage: () => {
        ensured.push(state.tabs.length)

        if (state.tabs.length === 0) {
          const id = 100 + ensured.length

          state.tabs.push({
            id,
            url: null,
            title: '新标签页',
            loading: false,
            favicon: null,
            canGoBack: false,
            canGoForward: false,
            zoom: 0,
          })
          state.activeTabId = id
        }
      },
      closeTab: (tabId) => {
        closed.push(tabId)
      },
      selectTab: (tabId) => {
        selected.push(tabId)
      },
      userAgent: () => 'kernel-ua',
      browserVersion: () => 'Chrome/999',
    },
    {
      logger: log,
      clock,
      instanceId: 'poietica-test',
      createSocket,
    },
  )

  client.onConnectedChange((next) => {
    connected.push(next)
  })
  client.onAttachedChange((ids) => {
    attachedLog.push(ids)
  })
  client.setTarget(target(9224))

  const socket = FakeSocket.instances[0] as FakeSocket

  if (openSocket) socket.open()

  return {
    socket,
    contents,
    opened,
    openedActive,
    closed,
    selected,
    ensured,
    connected,
    attachedLog,
    clock,
    log,
    client,
    state,
  }
}

async function rpc(socket: FakeSocket, request: Record<string, unknown>): Promise<Sent> {
  const id = socket.sent.length + 1000

  socket.deliver({ t: 'rpc', id, ...request })

  for (let tick = 0; tick < 50; tick += 1) {
    const reply = socket.messages().find((message) => message.t === 'rpcResult' && message.id === id)

    if (reply !== undefined) {
      return reply
    }

    await Promise.resolve()
  }

  throw new Error('这一轮的 rpc 没有回执')
}

beforeEach(() => {
  FakeSocket.instances = []
})

describe('BR-2: 握手与驱动标记', () => {
  test('打开后先发 hello，带这一侧的身份与内核自己的 UA', () => {
    const h = harness('https://a.example/')
    const hello = h.socket.messages().find((message) => message.t === 'hello')

    expect(h.socket.url).toBe(`ws://127.0.0.1:9224/ext?token=${TOKEN}`)
    expect(hello?.instanceId).toBe('poietica-test')
    expect(hello?.userAgent).toBe('kernel-ua')
    expect(hello?.browserVersion).toBe('Chrome/999')
    const helloed = hello as { tabs: readonly unknown[] }
    expect(helloed.tabs.length).toBe(1)

    h.client.dispose()
  })

  test('hello 带上全部标签快照，空白页的地址是空串（relay 那一侧的写法）', () => {
    const h = harness('')
    const hello = h.socket.messages().find((message) => message.t === 'hello')
    const tabs = hello?.tabs as {
      tabId: number
      url: string
      title: string
      active: boolean
      discarded: boolean
      windowId: number
      pinned: boolean
      groupId: number
    }[]

    expect(tabs).toEqual([
      { tabId: 1, url: '', title: 't', active: true, discarded: false, windowId: 1, pinned: false, groupId: -1 },
    ])
    expect(hello?.attachedTabIds).toEqual([])

    h.client.dispose()
  })

  /* 少了这个字段，omp 的 bridge 把整个实例判成不 eligible：一张 target 都发现不了，
   * 浏览器工具直接报「扩展过期」（实测 waitForRelayExtension 返回 outdated-extension）。 */
  test('hello 报 discardedTabsProtocol，否则 relay 判我们「扩展过期」', () => {
    const h = harness('https://a.example/')
    const hello = h.socket.messages().find((message) => message.t === 'hello')

    expect(hello?.discardedTabsProtocol).toBe(DISCARDED_TABS_PROTOCOL_VERSION)

    h.client.dispose()
  })

  test('一个标签都没有时 hello 前先补备用标签（不开进面板的普通标签）', () => {
    FakeSocket.instances = []

    const opened: (string | null)[] = []
    const ensured: number[] = []
    const state: BrowserState = {
      revision: 0,
      tabs: [],
      activeTabId: null,
      pickingTabId: null,
      recentlyClosed: [],
      driven: false,
    }
    const client = createRelayClient(
      {
        state: () => state,
        contentsOf: () => null,
        openTab: (next) => {
          opened.push(next)

          return 1
        },
        ensureAgentPage: () => {
          ensured.push(1)
        },
        closeTab: () => undefined,
        selectTab: () => undefined,
        userAgent: () => 'kernel-ua',
        browserVersion: () => 'Chrome/999',
      },
      {
        logger: createTestLogger(),
        clock: fakeClock(),
        instanceId: 'poietica-test',
        createSocket: (target) => new FakeSocket(target),
      },
    )

    const connected: boolean[] = []

    client.onConnectedChange((next) => {
      connected.push(next)
    })
    client.setTarget(target(9224))
    ;(FakeSocket.instances[0] as FakeSocket).open()

    expect(ensured).toEqual([1])
    expect(opened).toEqual([])
    expect(connected).toEqual([true])

    client.dispose()
  })
})

describe('BR-3 / BR-4: attach 与 detach', () => {
  test('没有文档的标签：先补 about:blank，再发 CDP', async () => {
    const h = harness('')

    const attach = await rpc(h.socket, { op: 'attach', tabId: 1 })

    expect(attach).toMatchObject({ ok: true })
    expect(h.contents.loaded).toEqual([BLANK_PAGE])

    const sent = await rpc(h.socket, { op: 'send', tabId: 1, method: 'Network.enable' })

    expect(sent).toMatchObject({ ok: true })
    expect(h.contents.commands).toEqual(['Network.enable'])

    h.client.dispose()
  })

  test('已经有文档的标签：一个多余的导航都不发', async () => {
    const h = harness('https://a.example/')

    await rpc(h.socket, { op: 'attach', tabId: 1 })

    expect(h.contents.loaded).toEqual([])

    h.client.dispose()
  })

  /* 一轮 detach 会发不止一条事件：后面的每一条若被读成「用户拆的」，relay 就把这张标签拉黑 —— 页面从 CDP 发现里消失，之后每次 browser.open 都只得到「没有可用页面」。 */
  test('BR-3: 一轮 detach 的回执都算 relay 主动，重 attach 后清除标记', async () => {
    const h = harness('https://a.example/')

    await rpc(h.socket, { op: 'attach', tabId: 1 })
    await rpc(h.socket, { op: 'detach', tabId: 1 })

    h.contents.debugger.emit('detach', {}, 'target closed')
    h.contents.debugger.emit('detach', {}, 'target closed')

    const reports = h.socket.messages().filter((message) => message.t === 'detached')

    expect(reports).toHaveLength(3)
    expect(reports.every((message) => message.relayInitiated === true)).toBe(true)

    await rpc(h.socket, { op: 'attach', tabId: 1 })
    h.contents.debugger.emit('detach', {}, 'devtools')

    expect(
      h.socket
        .messages()
        .filter((message) => message.t === 'detached')
        .at(-1)?.relayInitiated,
    ).toBe(false)

    h.client.dispose()
  })

  /* B-03：面板收起时视图是 setVisible(false)，Chromium 把这页当后台标签降频 —— 截图要么很久才回、要么根本不回；
   * 附着期间关掉这张标签的节流，分离时恢复。**只改这一张**：全局关节流会让用户自己开的后台标签一直跑满 CPU。 */
  test('B-03: 附着期间关掉这张标签的后台节流，分离时恢复', async () => {
    const h = harness('https://a.example/')

    await rpc(h.socket, { op: 'attach', tabId: 1 })

    expect(h.contents.throttled).toEqual([false])

    await rpc(h.socket, { op: 'detach', tabId: 1 })

    expect(h.contents.throttled).toEqual([false, true])

    h.client.dispose()
  })

  test('B-03: 内核自己发来的 detach 也把节流恢复回去', async () => {
    const h = harness('https://a.example/')

    await rpc(h.socket, { op: 'attach', tabId: 1 })
    h.contents.debugger.emit('detach', {}, 'Render process gone.')

    expect(h.contents.throttled).toEqual([false, true])

    h.client.dispose()
  })

  test('B-03: 重复 attach 不重复下发', async () => {
    const h = harness('https://a.example/')

    await rpc(h.socket, { op: 'attach', tabId: 1 })
    await rpc(h.socket, { op: 'attach', tabId: 1 })

    expect(h.contents.throttled).toEqual([false])

    h.client.dispose()
  })

  test('BR-4: 同一 WebContents attach 两次只挂一组监听', async () => {
    const h = harness('https://a.example/')

    await rpc(h.socket, { op: 'attach', tabId: 1 })
    await rpc(h.socket, { op: 'attach', tabId: 1 })
    await rpc(h.socket, { op: 'attach', tabId: 1 })

    expect(h.contents.debugger.listenerCount('detach')).toBe(1)
    expect(h.contents.debugger.listenerCount('message')).toBe(1)

    h.client.dispose()
  })

  test('BR-5: send 到无文档的标签先补 about:blank 再 sendCommand', async () => {
    const h = harness('')

    await rpc(h.socket, { op: 'send', tabId: 1, method: 'Runtime.evaluate' })

    expect(h.contents.loaded).toEqual([BLANK_PAGE])
    expect(h.contents.commands).toEqual(['Runtime.evaluate'])

    h.client.dispose()
  })

  test('标签命令转发到宿主：createTab / removeTab / activateTab，group 什么都不做', async () => {
    const h = harness('https://a.example/')

    const created = await rpc(h.socket, { op: 'createTab', url: 'https://b.example/' })

    expect(created).toMatchObject({ ok: true })
    expect(h.opened).toEqual(['https://b.example/'])

    await rpc(h.socket, { op: 'removeTab', tabId: 2 })
    await rpc(h.socket, { op: 'activateTab', tabId: 1 })

    expect(h.closed).toEqual([2])
    expect(h.selected).toEqual([1])

    const grouped = await rpc(h.socket, { op: 'group', tabIds: [1], title: '组', color: 'blue' })

    expect(grouped).toMatchObject({ ok: true, result: {} })

    h.client.dispose()
  })

  test('createTab 的 about:blank 落成空白页，而不是被当成非法地址', async () => {
    const h = harness('https://a.example/')

    await rpc(h.socket, { op: 'createTab', url: BLANK_PAGE })

    expect(h.opened).toEqual([null])
    expect(h.state.tabs.at(-1)?.url).toBeNull()

    h.client.dispose()
  })

  /* omp 的 newPage 带 background:true 时发 active:false：agent 要一张标签不等于要抢走用户正在看的那张。 */
  test('createTab 的 active 透传：false 时开在后台', async () => {
    const h = harness('https://a.example/')

    await rpc(h.socket, { op: 'createTab', url: 'https://b.example/', active: false })
    await rpc(h.socket, { op: 'createTab', url: 'https://c.example/' })

    expect(h.openedActive).toEqual([false, true])

    h.client.dispose()
  })

  test('认不出的 op 或坏掉的报文不会把这一侧打挂', () => {
    const h = harness('https://a.example/')

    h.socket.emit('message', { data: '{' })
    h.socket.emit('message', { data: JSON.stringify({ t: 'pong' }) })

    expect(() => {
      h.socket.deliver({ t: 'rpc', id: 1, op: 'launch-missiles' })
    }).not.toThrow()

    h.client.dispose()
  })
})

/* B-04：那条提示按「有没有标签挂着 AI 的调试器」算，不是按 socket 连着 —— relay 守护常驻，按连接算它会一直亮着。 */
describe('B-09: 非用户原因的内核 detach 不拉黑标签', () => {
  test('渲染进程崩溃：relayInitiated 为真', async () => {
    const h = harness('https://a.example/')

    await rpc(h.socket, { op: 'attach', tabId: 1 })
    h.contents.debugger.emit('detach', {}, 'Render process gone.')

    const report = h.socket
      .messages()
      .filter((message) => message.t === 'detached')
      .at(-1)

    expect(report?.reason).toBe('Render process gone.')
    expect(report?.relayInitiated).toBe(true)

    h.client.dispose()
  })

  test('用户主动拆（canceled_by_user）与被 DevTools 抢占：relayInitiated 为假', async () => {
    const h = harness('https://a.example/')

    await rpc(h.socket, { op: 'attach', tabId: 1 })
    h.contents.debugger.emit('detach', {}, 'canceled_by_user')
    h.contents.debugger.emit('detach', {}, 'Detached from DevTools')

    const reports = h.socket.messages().filter((message) => message.t === 'detached')

    expect(reports.map((message) => message.relayInitiated)).toEqual([false, false])

    h.client.dispose()
  })

  test('目标关闭等其它理由也当真', async () => {
    const h = harness('https://a.example/')

    await rpc(h.socket, { op: 'attach', tabId: 1 })
    h.contents.debugger.emit('detach', {}, 'target closed')
    h.contents.debugger.emit('detach', {}, '')

    const reports = h.socket.messages().filter((message) => message.t === 'detached')

    expect(reports.map((message) => message.relayInitiated)).toEqual([true, true])

    h.client.dispose()
  })
})

describe('B-04: 附着集合的通报', () => {
  test('连上不算附着：onAttachedChange 一条通知都没有', () => {
    const h = harness('https://a.example/')

    expect(h.attachedLog).toEqual([])

    h.client.dispose()
  })

  test('attach 后收到 [1]，detach 后收到 []', async () => {
    const h = harness('https://a.example/')

    await rpc(h.socket, { op: 'attach', tabId: 1 })

    expect(h.attachedLog).toEqual([[1]])

    await rpc(h.socket, { op: 'detach', tabId: 1 })

    expect(h.attachedLog).toEqual([[1], []])

    h.client.dispose()
  })

  test('重复 attach 不重复通报，内核发来的 detach 也算数', async () => {
    const h = harness('https://a.example/')

    await rpc(h.socket, { op: 'attach', tabId: 1 })
    await rpc(h.socket, { op: 'attach', tabId: 1 })

    expect(h.attachedLog).toEqual([[1]])

    h.contents.debugger.emit('detach', {}, 'Render process gone.')

    expect(h.attachedLog).toEqual([[1], []])

    h.client.dispose()
  })

  test('socket 断开时清空：非空才通报', async () => {
    const h = harness('https://a.example/')

    await rpc(h.socket, { op: 'attach', tabId: 1 })

    h.socket.drop()

    expect(h.attachedLog).toEqual([[1], []])

    h.clock.advance(1000)

    const second = FakeSocket.instances.at(-1) as FakeSocket

    second.open()
    second.drop()

    expect(h.attachedLog).toEqual([[1], []])

    h.client.dispose()
  })
})

describe('BR-6: 重连', () => {
  test('断开后 1s、2s、4s、8s、10s…封顶 10s', () => {
    const h = harness('https://a.example/')

    const retryAfter = (current: FakeSocket, delay: number): boolean => {
      const socketCount = (): number => FakeSocket.instances.length

      current.drop()
      FakeSocket.instances = []
      h.clock.advance(delay - 1)

      if (socketCount() !== 0) {
        return false
      }

      h.clock.advance(1)

      return socketCount() === 1
    }

    const first = h.socket

    expect(retryAfter(first, 1000)).toBe(true)
    expect(retryAfter(FakeSocket.instances[0] as FakeSocket, 2000)).toBe(true)
    expect(retryAfter(FakeSocket.instances[0] as FakeSocket, 4000)).toBe(true)
    expect(retryAfter(FakeSocket.instances[0] as FakeSocket, 8000)).toBe(true)
    expect(retryAfter(FakeSocket.instances[0] as FakeSocket, 10_000)).toBe(true)
    expect(retryAfter(FakeSocket.instances[0] as FakeSocket, 10_000)).toBe(true)

    h.client.dispose()
  })

  test('连上过一次就把退避重置回 1s', () => {
    const h = harness('https://a.example/')

    h.socket.drop()
    FakeSocket.instances = []
    h.clock.advance(1000)

    const second = FakeSocket.instances[0] as FakeSocket

    second.open()
    second.drop()
    FakeSocket.instances = []
    h.clock.advance(999)
    expect(FakeSocket.instances).toHaveLength(0)
    h.clock.advance(1)
    expect(FakeSocket.instances).toHaveLength(1)

    h.client.dispose()
  })

  test('setTarget(null) 停止重连（restarting 期间不再拨号）', () => {
    const h = harness('https://a.example/')

    h.socket.drop()
    h.client.setTarget(null)
    FakeSocket.instances = []
    h.clock.advance(60_000)

    expect(FakeSocket.instances).toHaveLength(0)

    h.client.dispose()
  })

  test('onConnectedChange 报真与假各一次', () => {
    const h = harness('https://a.example/')

    expect(h.connected).toEqual([true])

    h.socket.drop()

    expect(h.connected).toEqual([true, false])

    h.client.dispose()
  })

  test('连上后每 20s 发一次 ping', () => {
    const h = harness('https://a.example/')
    const before = h.socket.messages().filter((message) => message.t === 'ping').length

    h.clock.advance(20_000)

    expect(h.socket.messages().filter((message) => message.t === 'ping').length).toBe(before + 1)

    h.clock.advance(40_000)

    expect(h.socket.messages().filter((message) => message.t === 'ping').length).toBe(before + 3)

    h.client.dispose()
  })
})

describe('BR-7: 标签面增量推送', () => {
  test('标题变化只发一条 tabUpdated', () => {
    const h = harness('https://a.example/')
    const before = h.socket.messages().filter((message) => message.t === 'tabUpdated').length

    h.client.publish({
      ...h.state,
      revision: 2,
      tabs: [{ ...(h.state.tabs[0] as (typeof h.state.tabs)[number]), title: 'A 站' }],
    })

    const updates = h.socket.messages().filter((message) => message.t === 'tabUpdated')

    expect(updates).toHaveLength(before + 1)
    expect(updates.at(-1)?.tab).toMatchObject({ tabId: 1, title: 'A 站' })

    h.client.dispose()
  })

  test('没有变化就不重发', () => {
    const h = harness('https://a.example/')
    const before = h.socket.sent.length

    h.client.publish(h.state)
    h.client.publish(h.state)

    expect(h.socket.sent.length).toBe(before)

    h.client.dispose()
  })

  test('新标签发 tabCreated，关标签发 tabRemoved', () => {
    const h = harness('https://a.example/')

    h.client.publish({
      ...h.state,
      revision: 2,
      tabs: [
        ...h.state.tabs,
        {
          id: 2,
          url: 'https://b.example/',
          title: 'B',
          loading: false,
          favicon: null,
          canGoBack: false,
          canGoForward: false,
          zoom: 0,
        },
      ],
    })

    expect(h.socket.messages().filter((message) => message.t === 'tabCreated')).toHaveLength(1)

    h.client.publish({
      ...h.state,
      revision: 3,
      tabs: h.state.tabs,
    })

    expect(h.socket.messages().filter((message) => message.t === 'tabRemoved')).toHaveLength(1)

    h.client.dispose()
  })

  test('活动标签翻转也发 tabUpdated', () => {
    const h = harness('https://a.example/')

    h.client.publish({ ...h.state, revision: 2, activeTabId: null })

    expect(h.socket.messages().filter((message) => message.t === 'tabUpdated')).toHaveLength(1)

    h.client.dispose()
  })
})

describe('不变式：连着就至少有一张页（面板关空后 open 永久 10s 超时）', () => {
  test('连着时标签面变空：当场补备用标签，同一轮里先报 tabCreated 再报 tabRemoved，relay 的账一刻都不空', () => {
    const h = harness('https://a.example/')
    const before = h.socket.sent.length

    h.state.tabs.length = 0
    h.client.publish({ ...h.state, revision: 2 })

    const sent = h.socket.messages().slice(before)

    expect(h.ensured).toEqual([0])
    expect(sent.map((message) => message.t)).toEqual(['tabCreated', 'tabRemoved'])
    expect(sent.find((message) => message.t === 'tabRemoved')?.tabId).toBe(1)
    expect(sent.find((message) => message.t === 'tabCreated')?.tab).toMatchObject({ tabId: 101, url: '' })

    h.client.dispose()
  })

  test('反复关空反复补：按状态判，不是只在握手时补一次', () => {
    const h = harness('https://a.example/')

    for (let round = 0; round < 3; round += 1) {
      h.state.tabs.length = 0
      h.client.publish({ ...h.state, revision: round + 2 })
    }

    expect(h.ensured).toEqual([0, 0, 0])
    expect(h.socket.messages().filter((message) => message.t === 'tabCreated')).toHaveLength(3)

    h.client.dispose()
  })

  test('有页时不补；断开时不补（下一次握手再补）', () => {
    const h = harness('https://a.example/')

    h.client.publish({ ...h.state, revision: 2 })

    expect(h.ensured).toEqual([])

    h.client.setTarget(null)
    h.state.tabs.length = 0
    h.client.publish({ ...h.state, revision: 3 })

    expect(h.ensured).toEqual([])

    h.client.dispose()
  })
})

describe('BR-11: Core 报的端口 + 口令文件 → relay 地址', () => {
  test('5000 → 收掉（restarting 时调用方传 null）→ 5001；缺口令不连', () => {
    expect(relayTargetOf(5000, TOKEN)).toEqual(target(5000))
    expect(relayTargetOf(null, TOKEN)).toBeNull()
    expect(relayTargetOf(5001, TOKEN)).toEqual(target(5001))
    expect(relayTargetOf(5001, null)).toBeNull()
  })

  test('换地址真的换 socket：5000 断掉、5001 重新拨号', () => {
    const h = harness('https://a.example/')

    h.client.setTarget(target(5000))

    expect((FakeSocket.instances.at(-1) as FakeSocket).url).toBe(`ws://127.0.0.1:5000/ext?token=${TOKEN}`)

    h.client.setTarget(null)
    FakeSocket.instances = []
    h.client.setTarget(target(5001))

    expect((FakeSocket.instances.at(-1) as FakeSocket).url).toBe(`ws://127.0.0.1:5001/ext?token=${TOKEN}`)

    h.client.dispose()
  })

  test('同一目标重复设置不重拨；口令变了才重拨（口令不进日志）', () => {
    const h = harness('https://a.example/')
    const before = FakeSocket.instances.length

    h.client.setTarget(target(9224))

    expect(FakeSocket.instances).toHaveLength(before)

    h.client.setTarget({ url: 'http://127.0.0.1:9224', token: 'ab'.repeat(32) })

    expect(FakeSocket.instances).toHaveLength(before + 1)
    expect((FakeSocket.instances.at(-1) as FakeSocket).url).toBe(`ws://127.0.0.1:9224/ext?token=${'ab'.repeat(32)}`)
    h.client.dispose()
  })

  test('连接失败时日志只有 url 与错误，不出现口令', () => {
    const h = harness(
      'https://a.example/',
      () => {
        throw new Error('ECONNREFUSED')
      },
      false,
    )
    expect(h.log.records.length).toBeGreaterThan(0)
    const logged = JSON.stringify(h.log.records)
    expect(logged).not.toContain(TOKEN)
    expect(logged).not.toContain('ab'.repeat(32))

    h.client.dispose()
  })
})
