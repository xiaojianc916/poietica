import { describe, expect, test } from 'bun:test'
import {
  type AppContract,
  composeContracts,
  defineContract,
  defineErrors,
  defineMethod,
  defineNotification,
} from '@poietica/contract-kit'
import { AppError, SystemErrorCode } from '@poietica/foundation'
import { RawJson, Router, RpcPeer, type Transport } from '@poietica/rpc'
import { createTestLogger, transportPair } from '@poietica/test-kit'
import { z } from 'zod'
import type { CoreStatus, CoreSupervisor } from '../core-supervisor'
import { type HubWebContents, RpcHub } from '../rpc-hub'

const hostContract = defineContract({
  id: 'platform',
  namespaces: ['platform'],
  methods: [
    defineMethod({
      name: 'platform.ping',
      owner: 'host',
      params: z.object({}),
      result: z.object({ pong: z.boolean() }),
      description: '本地处理',
    }),
  ],
  notifications: [
    defineNotification({
      name: 'platform.tick',
      owner: 'host',
      params: z.object({ n: z.number() }),
      description: '广播',
    }),
  ],
  errors: defineErrors('platform', {}),
})

const coreContract = defineContract({
  id: 'conversation',
  namespaces: ['conversation'],
  methods: [
    defineMethod({
      name: 'conversation.list',
      owner: 'core',
      params: z.object({}),
      result: z.object({ items: z.array(z.string()) }),
      description: '转发给 Core',
    }),
    defineMethod({
      name: 'conversation.emitMe',
      owner: 'core',
      params: z.object({}),
      result: z.object({}),
      description: 'core 自己的方法',
    }),
  ],
  notifications: [
    defineNotification({
      name: 'conversation.changed',
      owner: 'core',
      params: z.object({ v: z.number() }),
      description: '来自 Core 的通知',
    }),
  ],
  errors: defineErrors('conversation', {}),
})

const appContract: AppContract = composeContracts(hostContract, coreContract)

/** 假的 CoreSupervisor：可控制 status 与 forward 的行为 */
function fakeSupervisor() {
  const log = createTestLogger()
  let status: CoreStatus = { state: 'starting', reason: null, attempt: 0 }
  const listeners = new Set<(s: CoreStatus) => void>()
  const forwarded: Array<{ method: string; params: unknown; meta: unknown }> = []
  let forwardImpl: (method: string, params: unknown, opts: { signal: AbortSignal }) => Promise<unknown> = async () => ({
    items: [],
  })
  const sup = {
    get status() {
      return status
    },
    setStatus(next: CoreStatus) {
      status = next
      for (const l of listeners) l(next)
    },
    onStatus: (l: (s: CoreStatus) => void) => {
      listeners.add(l)
      return {
        dispose: () => {
          listeners.delete(l)
        },
      }
    },
    forward: (method: string, params: unknown, opts: { signal: AbortSignal; meta: unknown }) => {
      forwarded.push({ method, params, meta: opts.meta })
      return forwardImpl(method, params, opts)
    },
    setForwardImpl(fn: typeof forwardImpl) {
      forwardImpl = fn
    },
    forwarded,
    logger: log,
  }
  return sup
}

interface WindowFake extends HubWebContents {
  fireNavigation(): void
  destroy(): void
}

function fakeWindow(id: number): WindowFake {
  const navListeners: Array<(d: { isMainFrame: boolean; isSameDocument: boolean }) => void> = []
  const destroyListeners: Array<() => void> = []
  return {
    id,
    on: (_e, l) => {
      navListeners.push(l as never)
      return undefined
    },
    once: (_e, l) => {
      destroyListeners.push(l as never)
      return undefined
    },
    fireNavigation: () => {
      for (const l of navListeners) l({ isMainFrame: true, isSameDocument: false })
    },
    destroy: () => {
      for (const l of destroyListeners) l()
    },
  }
}

interface HubHarness {
  readonly hub: RpcHub
  readonly sup: ReturnType<typeof fakeSupervisor>
  attach(wc: WindowFake): { peer: RpcPeer; onNotification: Map<string, unknown[]> }
  transportCount(): number
  lastTransport(): Transport
}

function makeHub(): HubHarness {
  const sup = fakeSupervisor()
  const hostRouter = new Router()
  hostRouter.register(hostContract.methods[0]!, () => ({ pong: true }))
  const hub = new RpcHub({
    appContract,
    hostRouter,
    supervisor: sup as unknown as Pick<CoreSupervisor, 'forward' | 'status' | 'onStatus'>,
    logger: createTestLogger(),
    createTransport: () => {
      const [a, b] = transportPair()
      pending.push(b)
      return a
    },
  })
  const pending: Transport[] = []
  const attach = (wc: WindowFake, index = -1): { peer: RpcPeer; onNotification: Map<string, unknown[]> } => {
    hub.attachWindow(wc)
    const transport = pending.at(index) ?? pending[pending.length - 1]!
    const onNotification = new Map<string, unknown[]>()
    const peer = new RpcPeer({
      name: `ui#${wc.id}`,
      transport,
      logger: createTestLogger(),
      defaultTimeoutMs: 1_000,
      onNotification: (m, params) => {
        const list = onNotification.get(m) ?? []
        list.push(params)
        onNotification.set(m, list)
      },
    })
    return { peer, onNotification }
  }
  return { hub, sup, attach, transportCount: () => pending.length, lastTransport: () => pending[pending.length - 1]! }
}

describe('RpcHub', () => {
  test('1. owner=host 的请求本地处理', async () => {
    const { attach } = makeHub()
    const { peer } = attach(fakeWindow(1))
    expect(await peer.request('platform.ping', {})).toEqual({ pong: true })
    peer.dispose()
  })

  test('2. owner=core 的请求转发并携带 meta.traceId', async () => {
    const { attach, sup } = makeHub()
    const { peer } = attach(fakeWindow(1))
    sup.setForwardImpl(async () => ({ items: ['a'] }))
    sup.setStatus({ state: 'ready', reason: null, attempt: 0 })
    const result = await peer.request('conversation.list', {})
    expect(result).toEqual({ items: ['a'] })
    expect(sup.forwarded.length).toBe(1)
    expect(sup.forwarded[0]!.method).toBe('conversation.list')
    peer.dispose()
  })

  test('3. 未知方法 → kernel.method_not_found', async () => {
    const { attach } = makeHub()
    const { peer } = attach(fakeWindow(1))
    const err = await peer.request('nope.nope', {}).catch((e: unknown) => e)
    expect((err as AppError).code).toBe(SystemErrorCode.methodNotFound)
    peer.dispose()
  })

  test('4. Core 调用 owner=core 的方法被拒', async () => {
    const { hub } = makeHub()
    const err = await hub
      .handleFromCore('conversation.emitMe', {}, { id: 1, signal: new AbortController().signal, meta: undefined })
      .catch((e: unknown) => e)
    expect((err as AppError).code).toBe(SystemErrorCode.methodNotFound)
  })

  test('5. Core 调用 owner=host 的方法被放行', async () => {
    const { hub } = makeHub()
    expect(
      await hub.handleFromCore('platform.ping', {}, { id: 1, signal: new AbortController().signal, meta: undefined }),
    ).toEqual({ pong: true })
  })

  test('6. Core 的通知先给 Host 模块旁听，再广播给窗口', async () => {
    const { hub, attach } = makeHub()
    const { peer, onNotification } = attach(fakeWindow(1))
    const heard: Array<{ v: number }> = []
    const caller = hub.coreCaller()
    const d = caller.on(coreContract, 'conversation.changed', (p) => heard.push(p))
    hub.fromCore('conversation.changed', { v: 1 })
    expect(heard).toEqual([{ v: 1 }])
    await new Promise((r) => setTimeout(r, 5))
    expect(onNotification.get('conversation.changed')).toEqual([{ v: 1 }])
    d.dispose()
    hub.fromCore('conversation.changed', { v: 2 })
    expect(heard).toEqual([{ v: 1 }])
    peer.dispose()
  })

  test('7. 页面重新加载后换一个新的对端（旧对端作废）', async () => {
    const { attach, transportCount, lastTransport } = makeHub()
    const wc = fakeWindow(1)
    const { peer: first } = attach(wc)
    expect(transportCount()).toBe(1)
    wc.fireNavigation()
    expect(transportCount()).toBe(2)
    // 新页面在新的传输上工作正常
    const second = new RpcPeer({
      name: 'ui#1-new',
      transport: lastTransport(),
      logger: createTestLogger(),
      defaultTimeoutMs: 1_000,
    })
    expect(await second.request('platform.ping', {})).toEqual({ pong: true })
    first.dispose()
    second.dispose()
  })

  test('8. 窗口销毁后从表中移除（广播不再报错）', async () => {
    const { hub, attach } = makeHub()
    const wc = fakeWindow(1)
    const { peer } = attach(wc)
    wc.destroy()
    expect(() => hub.broadcast('conversation.changed', { v: 1 })).not.toThrow()
    peer.dispose()
  })

  test('coreCaller().call 调用 owner=host 的方法 → method_not_found', async () => {
    const { hub } = makeHub()
    const caller = hub.coreCaller()
    const err = await caller.call(hostContract, 'platform.ping', {}).catch((e: unknown) => e)
    expect((err as AppError).code).toBe(SystemErrorCode.methodNotFound)
  })

  test('coreCaller().call 转发并解析结果', async () => {
    const { hub, sup } = makeHub()
    sup.setForwardImpl(async () => ({ items: ['x'] }))
    sup.setStatus({ state: 'ready', reason: null, attempt: 0 })
    const caller = hub.coreCaller()
    expect(await caller.call(coreContract, 'conversation.list', {})).toEqual({ items: ['x'] })
  })

  test('coreCaller().on 订阅 owner=host 的通知 → method_not_found', () => {
    const { hub } = makeHub()
    const caller = hub.coreCaller()
    try {
      caller.on(hostContract, 'platform.tick', () => undefined)
    } catch (e) {
      expect((e as AppError).code).toBe(SystemErrorCode.methodNotFound)
    }
  })

  test('coreCaller().call 超时 → kernel.timeout', async () => {
    const { hub, sup } = makeHub()
    sup.setStatus({ state: 'ready', reason: null, attempt: 0 })
    sup.setForwardImpl(
      (_m, _p, opts) =>
        new Promise((_resolve, reject) => {
          opts.signal.addEventListener('abort', () => reject(new AppError(SystemErrorCode.cancelled, '取消')))
        }),
    )
    const caller = hub.coreCaller()
    const err = await caller.call(coreContract, 'conversation.list', {}, { timeoutMs: 30 }).catch((e: unknown) => e)
    expect((err as AppError).code).toBe(SystemErrorCode.timeout)
  })

  /*
   * R-08-10：调用方可能拿一个长寿 signal（模块生命周期的 AbortController）反复调用，
   * 从前每次都在它上面挂一个 'abort' 监听且从不摘 —— 监听器与闭包（含每次的 ac）
   * 单调累积。现在监听器在 finally 里摘掉，净增量必须是 0。
   */
  test('R-08-10 用同一个长寿 signal 调用 100 次：abort 监听器净增 0', async () => {
    const { hub, sup } = makeHub()
    sup.setStatus({ state: 'ready', reason: null, attempt: 0 })
    sup.setForwardImpl(async () => ({ items: [] }))
    const caller = hub.coreCaller()

    /* 包装一个真 signal，只为数一数宿主上的监听器（Bun 的 EventTarget 不暴露计数） */
    const controller = new AbortController()
    let listeners = 0
    const signal = {
      get aborted() {
        return controller.signal.aborted
      },
      addEventListener: (_type: string, _fn: unknown) => {
        listeners += 1
      },
      removeEventListener: (_type: string, _fn: unknown) => {
        listeners -= 1
      },
    } as unknown as AbortSignal

    for (let i = 0; i < 100; i += 1) {
      await caller.call(coreContract, 'conversation.list', {}, { signal })
    }
    expect(listeners).toBe(0)
  })

  test('R-08-10 signal 已经 aborted 时请求立刻被取消（不再挂监听）', async () => {
    const { hub, sup } = makeHub()
    sup.setStatus({ state: 'ready', reason: null, attempt: 0 })
    sup.setForwardImpl((_m, _p, opts) => {
      /* 与 RpcPeer.request 同形：已经中止的 signal 直接拒绝 */
      if (opts.signal.aborted) return Promise.reject(new AppError(SystemErrorCode.cancelled, '取消'))
      return new Promise((_resolve, reject) => {
        opts.signal.addEventListener('abort', () => reject(new AppError(SystemErrorCode.cancelled, '取消')))
      })
    })
    const caller = hub.coreCaller()
    const ac = new AbortController()
    ac.abort()
    const err = await caller.call(coreContract, 'conversation.list', {}, { signal: ac.signal }).catch((e: unknown) => e)
    expect((err as AppError).code).toBe(SystemErrorCode.cancelled)
  })

  test('coreCaller().onStatus 转发 supervisor 的状态变化', () => {
    const { hub, sup } = makeHub()
    const caller = hub.coreCaller()
    const seen: string[] = []
    const d = caller.onStatus((s) => seen.push(s.state))
    sup.setStatus({ state: 'ready', reason: null, attempt: 0 })
    expect(seen).toEqual(['ready'])
    expect(caller.status().state).toBe('ready')
    d.dispose()
  })

  describe('P6 Host 只看信封：Core 的载荷原样转交', () => {
    /** 记下 value() 被调了几次：Host 转交时不该解析 */
    class CountingRaw extends RawJson {
      calls = 0
      override value(): unknown {
        this.calls += 1
        return super.value()
      }
    }

    test('Core 通知：没有旁听者时不解析，窗口收到的值与 Core 发出的一致', async () => {
      const { hub, attach } = makeHub()
      const { peer, onNotification } = attach(fakeWindow(1))
      const raw = new CountingRaw('{"v":7}')
      hub.fromCore('conversation.changed', raw)
      await new Promise((r) => setTimeout(r, 5))
      expect(raw.calls).toBe(0)
      expect(onNotification.get('conversation.changed')).toEqual([{ v: 7 }])
      peer.dispose()
    })

    test('Core 通知：有旁听者时只解析一次，旁听者拿到值', () => {
      const { hub } = makeHub()
      const heard: Array<{ v: number }> = []
      const caller = hub.coreCaller()
      caller.on(coreContract, 'conversation.changed', (p) => heard.push(p))
      caller.on(coreContract, 'conversation.changed', (p) => heard.push(p))
      hub.fromCore('conversation.changed', new CountingRaw('{"v":8}'))
      expect(heard).toEqual([{ v: 8 }, { v: 8 }])
    })

    test('UI 请求 core 方法：Hub 不解析结果，窗口收到原值', async () => {
      const { attach, sup } = makeHub()
      const { peer } = attach(fakeWindow(1))
      const raw = new CountingRaw('{"items":["中文"]}')
      sup.setForwardImpl(async () => raw)
      sup.setStatus({ state: 'ready', reason: null, attempt: 0 })
      expect(await peer.request('conversation.list', {})).toEqual({ items: ['中文'] })
      expect(raw.calls).toBe(0)
      peer.dispose()
    })

    test('Core 调 Host 方法与 coreCaller().call：RawJson 解析后才交给路由 / 契约校验', async () => {
      const { hub, sup } = makeHub()
      expect(
        await hub.handleFromCore('platform.ping', new CountingRaw('{}'), {
          id: 1,
          signal: new AbortController().signal,
          meta: undefined,
        }),
      ).toEqual({ pong: true })
      sup.setForwardImpl(async () => new CountingRaw('{"items":["x"]}'))
      sup.setStatus({ state: 'ready', reason: null, attempt: 0 })
      expect(await hub.coreCaller().call(coreContract, 'conversation.list', {})).toEqual({ items: ['x'] })
    })
  })
})
