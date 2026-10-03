/*
 * relay 这一侧（agent 那条线）的自检。真 Chromium 不参与：'electron' 换成假的，
 * WebSocket 换成只记账的假连接，钉住三件在真机上要靠时序才看得见的事：
 *
 *   1. 内核里没有文档的标签，发 CDP 之前先补一张 about:blank。没导航过的 WebContents
 *      收不到 CDP（Electron 不回执也不报错），relay 那边只会等到 20s 超时；
 *   2. omp 的 newPage 用 about:blank 要一个标签：那是宿主的「空白页」（url 为 null），
 *      不是一条地址，不能当归一化失败拒掉；
 *   3. hello 带这一侧的身份与内核自己的 UA（主进程的 navigator 是 Node 的）。
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test'

import type { BrowserState } from './host'

mock.module('electron', () => ({
  /*
   * 同一个进程里 host.test.ts 也 mock 这个模块：两份工厂必须是并集，少一格就是
   * 「Export named 'x' not found」。浏览器身份问的是分区会话 —— 它没有标签时也有答案。
   */
  session: { fromPartition: () => ({ getUserAgent: () => 'kernel-ua' }) },
  WebContentsView: class {},
}))

const { createBrowserRelay } = await import('./relay')

interface Sent {
  readonly t?: string
  readonly id?: number
  readonly ok?: boolean
  readonly result?: unknown
  readonly error?: string
  readonly [key: string]: unknown
}

class FakeSocket {
  static readonly OPEN = 1
  static readonly instances: FakeSocket[] = []
  readyState = 0
  readonly url: string
  readonly sent: string[] = []
  #listeners = new Map<string, ((event: unknown) => void)[]>()

  constructor(url: string) {
    this.url = url
    FakeSocket.instances.push(this)
  }

  addEventListener(type: string, listener: (event: unknown) => void): void {
    this.#listeners.set(type, [...(this.#listeners.get(type) ?? []), listener])
  }

  send(text: string): void {
    this.sent.push(text)
  }

  close(): void {
    this.readyState = 3
    this.#emit('close')
  }

  /** 服务端那一侧：握手完成、给这一侧发消息。 */
  open(): void {
    this.readyState = FakeSocket.OPEN
    this.#emit('open')
  }

  deliver(message: unknown): void {
    this.#emit('message', { data: JSON.stringify(message) })
  }

  messages(): Sent[] {
    return this.sent.map((text) => JSON.parse(text) as Sent)
  }

  async rpc(request: Record<string, unknown>): Promise<Sent> {
    const id = this.sent.length + 1000

    this.deliver({ t: 'rpc', id, ...request })

    for (let tick = 0; tick < 200; tick += 1) {
      const reply = this.messages().find(
        (message) => message.t === 'rpcResult' && message.id === id,
      )

      if (reply !== undefined) {
        return reply
      }

      await new Promise((resolve) => setTimeout(resolve, 1))
    }

    throw new Error('这一轮的 rpc 没有回执')
  }

  #emit(type: string, event: unknown = {}): void {
    for (const listener of this.#listeners.get(type) ?? []) {
      listener(event)
    }
  }
}

/* relay 用全局 WebSocket 拨 relay 服务端：这里换成假连接，全程不出本进程。 */
globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket

interface FakeContents {
  readonly loaded: string[]
  readonly commands: string[]
  readonly debugger: {
    isAttached: () => boolean
    attach: () => void
    detach: () => void
    on: (event: string, listener: (...args: unknown[]) => void) => void
    emit: (event: string, ...args: unknown[]) => void
    listenerCount: (event: string) => number
    sendCommand: (method: string) => Promise<unknown>
  }
  getUserAgent: () => string
  getURL: () => string
  isLoading: () => boolean
  loadURL: (url: string) => Promise<void>
}

interface Harness {
  readonly socket: FakeSocket
  readonly contents: FakeContents
  readonly opened: (string | null)[]
  readonly state: BrowserState
  readonly stop: () => void
}

function fakeContents(url: string): FakeContents {
  const loaded: string[] = []
  const commands: string[] = []
  const listeners = new Map<string, ((...args: unknown[]) => void)[]>()
  let current = url
  let attached = false

  const emit = (event: string, ...args: unknown[]): void => {
    for (const listener of listeners.get(event) ?? []) {
      listener(...args)
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
      on: (event, listener) => {
        listeners.set(event, [...(listeners.get(event) ?? []), listener])
      },
      emit,
      listenerCount: (event) => (listeners.get(event) ?? []).length,
      sendCommand: (method: string) => {
        commands.push(method)

        return Promise.resolve({ method })
      },
    },
    getUserAgent: () => 'kernel-ua',
    getURL: () => current,
    isLoading: () => false,
    loadURL: (next: string) => {
      loaded.push(next)
      current = next

      return Promise.resolve()
    },
  }
}

function harness(url: string): Harness {
  FakeSocket.instances.length = 0

  const contents = fakeContents(url)
  const opened: (string | null)[] = []
  const state: BrowserState = {
    revision: 1,
    tabs: [{ id: 0, url: url === '' ? null : url, title: 't', loading: false, favicon: null }],
    activeTabId: 0,
    pickingTabId: null,
    recentlyClosed: [],
  }

  const host = {
    state: () => state,
    contentsOf: (id: number) => (id === 0 ? contents : null),
    openTab: (next?: string | null) => {
      opened.push(next ?? null)

      return 1
    },
    closeTab: () => undefined,
    selectTab: () => undefined,
  }

  const relay = createBrowserRelay(host as never, {
    url: 'http://127.0.0.1:9224',
    onDriven: () => undefined,
  })

  relay.start()

  const socket = FakeSocket.instances[0] as FakeSocket

  socket.open()

  return { socket, contents, opened, state, stop: () => relay.stop() }
}

beforeEach(() => {
  FakeSocket.instances.length = 0
})

describe('relay', () => {
  test('没有文档的标签：先补 about:blank，再发 CDP', async () => {
    const { socket, contents, stop } = harness('')

    const attach = await socket.rpc({ op: 'attach', tabId: 0 })

    expect(attach).toMatchObject({ ok: true })
    expect(contents.loaded).toEqual(['about:blank'])

    const sent = await socket.rpc({ op: 'send', tabId: 0, method: 'Network.enable' })

    expect(sent).toMatchObject({ ok: true })
    expect(contents.commands).toEqual(['Network.enable'])

    stop()
  })

  test('已经有文档的标签：一个多余的导航都不发', async () => {
    const { socket, contents, stop } = harness('https://a.example/')

    await socket.rpc({ op: 'attach', tabId: 0 })

    expect(contents.loaded).toEqual([])

    stop()
  })

  /*
   * 内核为一轮 detach 会发不止一条 detach 事件。只有第一条是「我们主动拆的」，
   * 后面的每一条若被读成「用户拆的」，relay 就把这张标签拉黑：面板的页面从 CDP
   * 发现里消失，之后每次 browser.open 都只得到「没有可用页面」。
   */
  test('一轮 detach 的回执都算 relay 主动，标签不会被拉黑', async () => {
    const { socket, contents, stop } = harness('https://a.example/')

    await socket.rpc({ op: 'attach', tabId: 0 })
    await socket.rpc({ op: 'detach', tabId: 0 })

    contents.debugger.emit('detach', {}, 'target closed')
    contents.debugger.emit('detach', {}, 'target closed')

    const reports = socket.messages().filter((message) => message.t === 'detached')

    expect(reports).toHaveLength(3)
    expect(reports.every((message) => message['relayInitiated'] === true)).toBe(true)

    // 监听按内核对象挂一次：反复 attach 不该把它变成第二份回执
    await socket.rpc({ op: 'attach', tabId: 0 })
    await socket.rpc({ op: 'attach', tabId: 0 })

    expect(contents.debugger.listenerCount('detach')).toBe(1)
    expect(contents.debugger.listenerCount('message')).toBe(1)

    // 重新 attach 之后不再欠着上一轮：真·非 relay 的 detach 照旧老实报 false
    contents.debugger.emit('detach', {}, 'devtools')

    expect(
      socket
        .messages()
        .filter((message) => message.t === 'detached')
        .at(-1)?.['relayInitiated'],
    ).toBe(false)

    stop()
  })

  test('createTab 的 about:blank 落成空白页，而不是被当成非法地址', async () => {
    const { socket, opened, stop } = harness('https://a.example/')

    const reply = await socket.rpc({ op: 'createTab', url: 'about:blank' })

    expect(reply).toMatchObject({ ok: true })
    expect(opened).toEqual([null])

    stop()
  })

  test('hello 带这一侧的身份与内核自己的 UA', () => {
    const { socket, stop } = harness('https://a.example/')
    const hello = socket.messages().find((message) => message.t === 'hello')

    expect(typeof hello?.['instanceId']).toBe('string')
    expect(String(hello?.['instanceId'])).toStartWith('poietica-')
    expect(hello?.['userAgent']).toBe('kernel-ua')
    expect(hello?.['browserVersion']).toStartWith('Chrome/')

    stop()
  })
})
