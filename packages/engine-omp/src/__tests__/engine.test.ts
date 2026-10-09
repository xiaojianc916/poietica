import { describe, expect, test } from 'bun:test'
import { EngineErrorCode, type EngineSession, type EngineToolSpec } from '@poietica/engine'
import { AppError, Deferred, noopLogger } from '@poietica/foundation'
import type { TranscriptOperation } from '@poietica/transcript'
import { z } from 'zod'
import { OmpEngine } from '../engine'

function stubSession(): EngineSession {
  return {
    sessionId: 's1',
    sessionFile: 'f1',
    state: () => 'idle',
    isBusy: () => false,
    subscribe: () => ({ dispose: () => undefined }),
    submit: async () => undefined,
    cancel: async () => undefined,
    queue: () => ({ items: [], modes: { steer: 'all', followUp: 'all' } }),
    withdraw: () => undefined,
    moveQueued: async () => undefined,
    setQueueModes: () => undefined,
    controls: () => ({
      model: { current: null, choices: [] },
      thinking: { current: null, choices: [] },
      posture: 'ask',
      planMode: false,
      goal: null,
      available: { plan: true, goal: true },
      context: null,
    }),
    setModel: async () => undefined,
    setThinking: () => undefined,
    setPosture: () => undefined,
    setPlanMode: async () => undefined,
    setGoal: async () => undefined,
    interactions: () => [],
    respond: () => undefined,
    page: async () => ({
      items: [],
      tasks: [],
      interactions: [],
      attachments: [],
      todos: [],
      prompts: [],
      meta: {},
      hasMoreOlder: false,
    }),
    dispose: async () => undefined,
  }
}

const spec = (key: string) => ({
  key,
  cwd: 'C:\\work',
  sessionFile: null,
  posture: 'ask' as const,
  model: null,
  thinking: null,
})

const tool: EngineToolSpec<z.ZodObject<{ text: z.ZodString }>> = {
  name: 'demo_tool',
  label: '演示',
  description: 'demo',
  parameters: z.object({ text: z.string() }),
  approval: 'read',
  execute: async (params) => ({ text: params.text }),
}

function makeEngine(over: Partial<ConstructorParameters<typeof OmpEngine>[0]> = {}) {
  const opened: string[] = []
  const engine = new OmpEngine({
    info: { name: 'omp', version: '18.5.0' },
    /*
     * 草稿表这一支：OmpEngine 只做转发，实际组装在组合根（ports/draft-controls.ts）。
     * 这里给一个空表替身即可 —— 组装规则的用例在 engine-testkit 的 C-DRAFT-CONTROLS
     * 与 ports/__tests__/draft-controls.test.ts。
     */
    draftControls: async () => ({
      model: { current: null, choices: [] },
      thinking: { current: null, choices: [] },
      posture: 'ask',
      planMode: false,
      goal: null,
      available: { plan: true, goal: true },
      context: null,
    }),
    logger: noopLogger,
    createSession: async (sessionSpec) => {
      opened.push(sessionSpec.key)
      return stubSession()
    },
    sessionFiles: {
      exists: async () => true,
      fork: async () => ({ sessionId: 'x', sessionFile: 'y' }),
      delete: async () => undefined,
      exportHtml: async () => undefined,
      exportMarkdown: async () => '',
    },
    models: {
      providers: async () => [],
      models: async () => [],
      setApiKey: async () => undefined,
      clearApiKey: async () => undefined,
      setModelEnabled: async () => undefined,
      defaultModel: async () => null,
      setDefaultModel: async () => undefined,
      defaultThinking: async () => null,
      setDefaultThinking: async () => undefined,
      upsertCustomProvider: async () => undefined,
      removeCustomProvider: async () => undefined,
      onDidChange: () => ({ dispose: () => undefined }),
    },
    settings: {
      groupOrder: [],
      catalog: async () => [],
      set: async () => undefined,
      reset: async () => undefined,
      capabilities: async () => ({ computerUse: false, browserControl: false }),
      setCapability: async () => undefined,
      getPythonInterpreter: async () => null,
      setPythonInterpreter: async () => undefined,
      onDidChange: () => ({ dispose: () => undefined }),
    },
    skills: {
      list: async () => [],
      setEnabled: async () => undefined,
      installFromDirectory: async () => ({
        id: 'x',
        name: 'x',
        description: '',
        source: 'user',
        enabled: true,
        path: '',
      }),
      installFromZip: async () => ({ id: 'x', name: 'x', description: '', source: 'user', enabled: true, path: '' }),
      forget: async () => undefined,
      read: async () => ({ markdown: '' }),
    },
    mcp: {
      list: async () => [],
      upsert: async () => undefined,
      remove: async () => undefined,
      status: async () => [],
      onDidChangeStatus: () => ({ dispose: () => undefined }),
    },
    plugins: {
      list: async () => [],
      marketplace: async () => [],
      install: async () => ({ id: 'x', name: 'x', version: '0', description: '', enabled: true, source: '' }),
      uninstall: async () => undefined,
      setEnabled: async () => undefined,
    },
    disposeRuntime: async () => undefined,
    ...over,
  })
  void (undefined as unknown as TranscriptOperation)
  return { engine, opened }
}

describe('OmpEngine', () => {
  test('冻结之前 openSession 抛 engine.tools_frozen（防止会话拿到不完整的工具表）', async () => {
    const { engine } = makeEngine()
    const error = await engine.openSession(spec('a')).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(AppError)
    expect((error as AppError).code).toBe(EngineErrorCode.toolsFrozen)
  })

  test('冻结之后 registerTool 抛 engine.tools_frozen', () => {
    const { engine } = makeEngine()
    engine.freezeTools()
    const error = (() => {
      try {
        engine.registerTool(tool)
      } catch (e) {
        return e
      }
      return undefined
    })()
    expect(error).toBeInstanceOf(AppError)
    expect((error as AppError).code).toBe(EngineErrorCode.toolsFrozen)
  })

  test('重名工具抛 kernel.conflict', () => {
    const { engine } = makeEngine()
    engine.registerTool(tool)
    const error = (() => {
      try {
        engine.registerTool(tool)
      } catch (e) {
        return e
      }
      return undefined
    })()
    expect((error as AppError).code).toBe('kernel.conflict')
  })

  test('冻结后可以开会话，toolSpecs 暴露已注册的工具', async () => {
    const { engine, opened } = makeEngine()
    engine.registerTool(tool)
    engine.freezeTools()
    const session = await engine.openSession(spec('thread-1'))
    expect(session.sessionId).toBe('s1')
    expect(opened).toEqual(['thread-1'])
    expect(engine.toolSpecs().has('demo_tool')).toBe(true)
  })

  test('registerTool 返回的 Disposable 在冻结前能撤销', () => {
    const { engine } = makeEngine()
    const sub = engine.registerTool(tool)
    expect(engine.toolSpecs().has('demo_tool')).toBe(true)
    sub.dispose()
    expect(engine.toolSpecs().has('demo_tool')).toBe(false)
  })

  test('dispose 之后再开会话抛 kernel.cancelled', async () => {
    const { engine } = makeEngine()
    engine.freezeTools()
    await engine.dispose()
    const error = await engine.openSession(spec('a')).catch((e: unknown) => e)
    expect((error as AppError).code).toBe('kernel.cancelled')
  })

  /*
   * R-05 §3.1（M1）：会话池释放一条空闲会话走的是 session.dispose()，不经过引擎；
   * 旧代码只在 engine.dispose() 里清空登记表，于是每释放一条就多抱一个已关闭的
   * AgentSession（含消息历史、投影器、工具实例）。释放即注销：谁关的都要摘掉。
   */
  test('R-05 M1 会话被 dispose 就从登记表移除；engine.dispose 不重复关', async () => {
    const sessions: EngineSession[] = []
    const disposed: string[] = []
    const { engine } = makeEngine({
      createSession: async (sessionSpec) => {
        const session = stubSession()
        const original = session.dispose.bind(session)
        session.dispose = async () => {
          disposed.push(sessionSpec.key)
          await original()
        }
        sessions.push(session)
        return session
      },
    })
    engine.freezeTools()
    await engine.openSession(spec('a'))
    await engine.openSession(spec('b'))
    await engine.openSession(spec('c'))
    expect(engine.liveSessionCount()).toBe(3)

    await sessions[0]!.dispose()
    await sessions[1]!.dispose()
    expect(engine.liveSessionCount()).toBe(1)

    await engine.dispose()
    expect(engine.liveSessionCount()).toBe(0)
    expect(disposed).toEqual(['a', 'b', 'c'])
  })

  /*
   * R-05 §3.1 的附带竞态（M2）：openSession 的 await 期间 dispose 已经开始 —— 旧代码
   * 会在遍历结束后才 add，新会话永远不被关闭，调用方还拿到一个活的句柄。
   */
  test('R-05 M2 打开与关闭赛跑：落地的会话当场关闭，openSession 以 cancelled 拒绝', async () => {
    const opening = new Deferred<EngineSession>()
    const session = stubSession()
    let disposed = 0
    const original = session.dispose.bind(session)
    session.dispose = async () => {
      disposed += 1
      await original()
    }
    const { engine } = makeEngine({ createSession: () => opening.promise })
    engine.freezeTools()

    const pending = engine.openSession(spec('a'))
    const closing = engine.dispose()
    opening.resolve(session)

    const error = await pending.catch((e: unknown) => e)
    await closing
    expect((error as AppError).code).toBe('kernel.cancelled')
    expect(disposed).toBe(1)
    expect(engine.liveSessionCount()).toBe(0)
  })
})
