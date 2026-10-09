import { beforeEach, describe, expect, test } from 'bun:test'
import { createTestLogger, type FakeClock, fakeClock } from '@poietica/test-kit'
import { BLANK_PAGE, type BrowserState } from '../../contract'
import { createRelayClient, type RelaySocket, relayUrlForStatus } from '../relay-client'
import type { ContentsListener, WebContentsLike } from '../tabs'

/*
 * relay 这一侧（agent 那条线）的自检。真 Chromium 与真 WebSocket 都不参与：socket 从
 * `createSocket` 注入，时间从 `clock` 注入 —— 这一组断言**迁移自** legacy relay.test.ts
 * 的全部意图，钉住 BR-2…BR-7 与 BR-11。
 */

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

  /** 服务端那一侧：握手完成。 */
  open(): void {
    this.readyState = FakeSocket.OPEN
    this.emit('open')
  }

  /** 服务端那一侧：连接断掉（不是这一侧叫的 close）。 */
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
  readonly debugger: FakeDebugger
}

function fakeContents(url: string): FakeContents {
  const loaded: string[] = []
  const commands: string[] = []
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
    debugger: {
      isAttached: () => attached,
      attach: () => {
        attached = true
      },
      // 内核是真的发事件：这里照发，一轮 detach 可以发不止一条。
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
  readonly closed: number[]
  readonly selected: number[]
  readonly connected: boolean[]
  readonly clock: FakeClock
  readonly client: ReturnType<typeof createRelayClient>
  readonly state: BrowserState
}

function harness(url: string): Harness {
  FakeSocket.instances = []

  const contents = fakeContents(url)
  const opened: (string | null)[] = []
  const closed: number[] = []
  const selected: number[] = []
  const connected: boolean[] = []
  const clock = fakeClock()
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
      openTab: (next) => {
        opened.push(next)
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
      logger: createTestLogger(),
      clock,
      instanceId: 'poietica-test',
      createSocket: (target) => new FakeSocket(target),
    },
  )

  client.onConnectedChange((next) => {
    connected.push(next)
  })
  client.setUrl('http://127.0.0.1:9224')

  const socket = FakeSocket.instances[0] as FakeSocket

  socket.open()

  return { socket, contents, opened, closed, selected, connected, clock, client, state }
}

/** 一问一答：假 socket 上没有事件循环，答案在同一批微任务里就位。 */
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

    expect(h.socket.url).toBe('ws://127.0.0.1:9224/ext')
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
      windowId: number
      pinned: boolean
      groupId: number
    }[]

    expect(tabs).toEqual([{ tabId: 1, url: '', title: 't', active: true, windowId: 1, pinned: false, groupId: -1 }])
    expect(hello?.attachedTabIds).toEqual([])

    h.client.dispose()
  })

  test('一个标签都没有时 hello 前先开空白标签', () => {
    FakeSocket.instances = []

    const opened: (string | null)[] = []
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
    client.setUrl('http://127.0.0.1:9224')
    ;(FakeSocket.instances[0] as FakeSocket).open()

    expect(opened).toEqual([null])
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

  /*
   * 内核为一轮 detach 会发不止一条 detach 事件。只有第一条是「我们主动拆的」，
   * 后面的每一条若被读成「用户拆的」，relay 就把这张标签拉黑：面板的页面从 CDP 发现里
   * 消失，之后每次 browser.open 都只得到「没有可用页面」。
   */
  test('BR-3: 一轮 detach 的回执都算 relay 主动，重 attach 后清除标记', async () => {
    const h = harness('https://a.example/')

    await rpc(h.socket, { op: 'attach', tabId: 1 })
    await rpc(h.socket, { op: 'detach', tabId: 1 })

    h.contents.debugger.emit('detach', {}, 'target closed')
    h.contents.debugger.emit('detach', {}, 'target closed')

    const reports = h.socket.messages().filter((message) => message.t === 'detached')

    expect(reports).toHaveLength(3)
    expect(reports.every((message) => message.relayInitiated === true)).toBe(true)

    // 重新 attach 之后不再欠着上一轮：真·非 relay 的 detach 照旧老实报 false。
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

describe('BR-6: 重连', () => {
  test('断开后 1s、2s、4s、8s、10s…封顶 10s', () => {
    const h = harness('https://a.example/')

    /** 断掉当前这条，再往前走一格：返回下一次重试是否在正好那个毫秒上发生。 */
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
    // 已经到顶：10s 那一档一直用它，不再翻倍。
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

  test('setUrl(null) 停止重连（restarting 期间不再拨号）', () => {
    const h = harness('https://a.example/')

    h.socket.drop()
    h.client.setUrl(null)
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

describe('BR-11: Core 状态 → relay 地址', () => {
  test('ready(5000) → restarting → ready(5001)', () => {
    expect(relayUrlForStatus('ready', 5000)).toBe('http://127.0.0.1:5000')
    expect(relayUrlForStatus('restarting', 5000)).toBeNull()
    expect(relayUrlForStatus('ready', 5001)).toBe('http://127.0.0.1:5001')
    expect(relayUrlForStatus('ready', null)).toBeNull()
  })

  test('换地址真的换 socket：5000 断掉、5001 重新拨号', () => {
    const h = harness('https://a.example/')

    h.client.setUrl('http://127.0.0.1:5000')

    expect((FakeSocket.instances.at(-1) as FakeSocket).url).toBe('ws://127.0.0.1:5000/ext')

    h.client.setUrl(null)
    FakeSocket.instances = []
    h.client.setUrl('http://127.0.0.1:5001')

    expect((FakeSocket.instances.at(-1) as FakeSocket).url).toBe('ws://127.0.0.1:5001/ext')

    h.client.dispose()
  })
})
