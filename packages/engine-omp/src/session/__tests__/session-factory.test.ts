import { describe, expect, test } from 'bun:test'
import { Settings } from '@oh-my-pi/pi-coding-agent/config/settings'
import type { EngineSession, OpenSessionSpec } from '@poietica/engine'
import { noopLogger } from '@poietica/foundation'
import { testLayout } from '../../__tests__/omp-home'
import { SessionFactory, type SessionFactoryOptions } from '../session-factory'

/*
 * 开会话时交给 omp 的那张选项表（omp 知识 #17）。
 *
 * omp 的自动起名只认 `createAgentSession({ autoTitle: true })`：宿主不传，`#noteTitleInput` 第一道门就返回，
 * 线程永远停在首句兜底上（真实故障：44 条线程里 30 条标题与首句截断逐字相同）。这条用例直接看入参，
 * 不经过 omp —— 也就是「有没有把开关交出去」这件事本身，而不是 omp 拿到之后怎么跑。
 */

const SPEC: OpenSessionSpec = {
  key: 'thread-1',
  cwd: 'C:\\work',
  sessionFile: null,
  posture: 'ask',
  model: null,
  thinking: null,
}

function stubSession(): EngineSession {
  return {
    sessionId: 'session-1',
    sessionFile: 'session-1.jsonl',
    subscribe: () => ({ dispose: () => undefined }),
    dispose: async () => undefined,
  } as unknown as EngineSession
}

/** 起一次 SessionFactory，返回它交给 omp 的选项表 */
async function optionsOf(spec: OpenSessionSpec, over: Partial<SessionFactoryOptions> = {}) {
  /* 用数组收：闭包里赋值在 TS 的控制流分析里不改变外部变量的收窄结果 */
  const captured: Record<string, unknown>[] = []
  const factory = new SessionFactory({
    layout: testLayout,
    logger: noopLogger,
    root: Settings.isolated(),
    createAgentSession: async (options) => {
      captured.push(options)
      return { session: { sessionId: 'session-1', sessionFile: 'session-1.jsonl' }, setToolUIContext: () => undefined }
    },
    sessionManager: {
      create: () => ({
        getSessionId: () => 'session-1',
        getSessionFile: () => 'session-1.jsonl',
        ensureOnDisk: async () => undefined,
      }),
      open: async () => ({ getSessionId: () => 'session-1', getSessionFile: () => 'session-1.jsonl' }),
    },
    authStorage: {},
    registry: {},
    tools: new Map(),
    resolveModel: () => null,
    modelRoles: () => ({}),
    wrapSession: async () => stubSession(),
    ...over,
  })
  await factory.create(spec)
  const first = captured[0]
  if (first === undefined) throw new Error('createAgentSession 没有被调用')
  return first
}

describe('自动起名的开关交给 omp（omp 知识 #17）', () => {
  test('F-AT-1 普通线程：autoTitle 交给 omp（不传就等于永远不起名）', async () => {
    expect((await optionsOf(SPEC)).autoTitle).toBe(true)
  })

  test('F-AT-2 用户定过名的线程（spec.autoTitle=false）：交给 omp 的是关闭', async () => {
    expect((await optionsOf({ ...SPEC, autoTitle: false })).autoTitle).toBe(false)
  })

  test('F-AT-3 测试缝 disableAutoTitle：mock 也是 tiny 候选，标题请求不许吃掉脚本回复', async () => {
    expect((await optionsOf(SPEC, { disableAutoTitle: true })).autoTitle).toBe(false)
  })
})

/*
 * 预热（SessionFactory.warm）：进程里第一次 createAgentSession 的冷启动提前在后台付掉。
 * 这里钉住的是「预热不产生任何外部效果」与「不破坏 omp 知识 #9 的串行」，而不是预热能快多少（那由基准测量）。
 */
describe('开会话预热', () => {
  function harness(over: Partial<SessionFactoryOptions> = {}) {
    const calls: Record<string, unknown>[] = []
    const effects: string[] = []
    let inFlight = 0
    let peak = 0
    let failNext = false
    const factory = new SessionFactory({
      layout: testLayout,
      logger: noopLogger,
      root: Settings.isolated(),
      createAgentSession: async (options) => {
        calls.push(options)
        inFlight += 1
        peak = Math.max(peak, inFlight)
        await Bun.sleep(5)
        inFlight -= 1
        if (failNext) {
          failNext = false
          throw new Error('cold start failed')
        }
        return {
          session: { dispose: async () => void effects.push('dispose') },
          setToolUIContext: () => undefined,
        }
      },
      sessionManager: {
        create: () => {
          effects.push('create')
          return {
            getSessionId: () => 'session-1',
            getSessionFile: () => 'session-1.jsonl',
            ensureOnDisk: async () => void effects.push('ensureOnDisk'),
          }
        },
        open: async () => ({ getSessionId: () => 'session-1', getSessionFile: () => 'session-1.jsonl' }),
        inMemory: (cwd) => {
          effects.push(`inMemory:${cwd}`)
          return { inMemory: true }
        },
      },
      authStorage: {},
      registry: {},
      mcp: {
        lease: async () => {
          effects.push('lease')
          return { manager: {}, attach: async () => undefined, release: () => undefined } as never
        },
      },
      tools: new Map(),
      resolveModel: () => null,
      modelRoles: () => ({}),
      wrapSession: async () => {
        effects.push('wrap')
        return stubSession()
      },
      ...over,
    })
    return {
      factory,
      calls,
      effects,
      peak: () => peak,
      failOnce: () => {
        failNext = true
      },
    }
  }

  test('F-W-1 预热只建内存会话再丢掉：不落盘、不借 MCP、不包装、不起 LSP、不发现用户扩展', async () => {
    const h = harness()
    await h.factory.warm('/tmp/warm')
    expect(h.effects).toEqual(['inMemory:/tmp/warm', 'dispose'])
    const options = h.calls[0]
    expect(options?.sessionManager).toEqual({ inMemory: true })
    expect(options).toMatchObject({
      hasUI: false,
      enableMCP: false,
      enableLsp: false,
      autoTitle: false,
      disableExtensionDiscovery: true,
    })
    expect(options?.mcpManager).toBeUndefined()
  })

  test('F-W-2 预热与真正的开会话接在同一条链上：createAgentSession 从不并发（omp 知识 #9）', async () => {
    const h = harness()
    await Promise.all([h.factory.warm('/tmp/warm'), h.factory.create(SPEC), h.factory.warm('/tmp/warm')])
    expect(h.calls).toHaveLength(3)
    expect(h.peak()).toBe(1)
  })

  test('F-W-3 预热失败不连累之后的开会话', async () => {
    const h = harness()
    h.failOnce()
    await expect(h.factory.warm('/tmp/warm')).rejects.toThrow('cold start failed')
    await h.factory.create(SPEC)
    expect(h.effects).toContain('wrap')
  })

  test('F-W-4 SessionManager 不支持内存会话：不预热', async () => {
    const h = harness({
      sessionManager: {
        create: () => ({ getSessionId: () => 's', getSessionFile: () => 's.jsonl' }),
        open: async () => ({ getSessionId: () => 's', getSessionFile: () => 's.jsonl' }),
      },
    })
    await h.factory.warm('/tmp/warm')
    expect(h.calls).toHaveLength(0)
  })
})
