import { describe, expect, test } from 'bun:test'
import { defineContract, defineErrors } from '@poietica/contract-kit'
import { AppError, defineServiceToken, SystemErrorCode } from '@poietica/foundation'
import { z } from 'zod'
import { defineCoreModule } from '../module'
import { alphaContract, alphaModule, handleAlpha, makeKernel } from './helpers'

describe('core-kernel 启动', () => {
  test('K-1 拓扑序 setup、逆序 onShutdown', async () => {
    const order: string[] = []
    const a = defineCoreModule({
      id: 'alpha',
      setup: (ctx) => {
        order.push('a.setup')
        ctx.lifecycle.onShutdown(() => {
          order.push('a.shutdown')
        })
      },
    })
    const b = defineCoreModule({
      id: 'beta',
      dependsOn: ['alpha'],
      setup: (ctx) => {
        order.push('b.setup')
        ctx.lifecycle.onShutdown(() => {
          order.push('b.shutdown')
        })
      },
    })
    const h = await makeKernel([b, a])
    expect(order).toEqual(['a.setup', 'b.setup'])
    await h.kernel.shutdown('done')
    expect(order).toEqual(['a.setup', 'b.setup', 'b.shutdown', 'a.shutdown'])
    await h.dispose()
  })

  test('K-1b setup 抛错时 start reject（Host 按退出码 1 处理）', async () => {
    const h = await makeKernel(
      [
        defineCoreModule({
          id: 'alpha',
          setup: () => {
            throw new AppError('alpha.boom', 'setup 炸了')
          },
        }),
      ],
      { start: false },
    )
    await expect(h.kernel.start()).rejects.toThrow('setup 炸了')
    await h.dispose()
  })

  test('K-2 契约里 owner=core 的方法没实现 → kernel.unhandled_method，message 含方法名', async () => {
    const h = await makeKernel([alphaModule(['alpha.explode', 'alpha.neverHandled'])], { start: false })
    try {
      await h.kernel.start()
      throw new Error('应当抛错')
    } catch (e) {
      expect(e).toBeInstanceOf(AppError)
      expect((e as AppError).code).toBe(SystemErrorCode.unhandledMethod)
      expect((e as AppError).message).toContain('alpha.explode')
      expect((e as AppError).message).toContain('alpha.neverHandled')
      expect((e as AppError).message).not.toContain('core.shutdown')
    }
    await h.dispose()
  })

  test('K-3 handle 一个不属于本模块契约的名字 → kernel.unhandled_method', async () => {
    let caught: unknown
    const h = await makeKernel(
      [
        defineCoreModule({
          id: 'alpha',
          contract: alphaContract,
          setup: (ctx) => {
            handleAlpha(ctx as never)
            try {
              ;(ctx.rpc as unknown as { handle(n: string, f: () => void): void }).handle('alpha.nope', () => undefined)
            } catch (e) {
              caught = e
            }
          },
        }),
      ],
      { start: false },
    )
    await h.kernel.start()
    expect(caught).toBeInstanceOf(AppError)
    expect((caught as AppError).code).toBe(SystemErrorCode.unhandledMethod)
  })

  test('K-3b emit 一个不属于本模块契约的通知 → kernel.unhandled_method', async () => {
    let caught: unknown
    const h = await makeKernel([
      defineCoreModule({
        id: 'alpha',
        contract: alphaContract,
        setup: (ctx) => {
          handleAlpha(ctx as never)
          try {
            ;(ctx.rpc as unknown as { emit(n: string, p: unknown): void }).emit('alpha.nope', {})
          } catch (e) {
            caught = e
          }
          ;(ctx.rpc as unknown as { emit(n: string, p: unknown): void }).emit('alpha.tick', { n: 1 })
        },
      }),
    ])
    expect((caught as AppError).code).toBe(SystemErrorCode.unhandledMethod)
    expect(h.notifications('alpha.tick')).toEqual([{ n: 1 }])
    await h.dispose()
  })

  test('K-3c strict 下通知参数不符合契约 → 抛 kernel.internal', async () => {
    let caught: unknown
    await makeKernel([
      defineCoreModule({
        id: 'alpha',
        contract: alphaContract,
        setup: (ctx) => {
          handleAlpha(ctx as never)
          try {
            ;(ctx.rpc as unknown as { emit(n: string, p: unknown): void }).emit('alpha.badTick', { s: 1 })
          } catch (e) {
            caught = e
          }
        },
      }),
    ])
    expect((caught as AppError).code).toBe(SystemErrorCode.internal)
  })

  test('K-4 未声明 dependsOn 却 get 别人的服务 → kernel.service_access_denied', async () => {
    const token = defineServiceToken<{ v: number }>('alpha', 'AlphaService')
    const h = await makeKernel(
      [
        defineCoreModule({
          id: 'alpha',
          setup: (ctx) => {
            ctx.services.provide(token, { v: 1 })
          },
        }),
        defineCoreModule({
          id: 'beta',
          setup: (ctx) => {
            ctx.services.get(token)
          },
        }),
      ],
      { start: false },
    )
    try {
      await h.kernel.start()
      throw new Error('应当抛错')
    } catch (e) {
      expect((e as AppError).code).toBe(SystemErrorCode.serviceAccessDenied)
    }
    await h.dispose()
  })

  test('K-4b 声明了 dependsOn 就能 get；内核能读取（harness 用途）', async () => {
    const token = defineServiceToken<{ v: number }>('alpha', 'AlphaService')
    let got: { v: number } | undefined
    const h = await makeKernel([
      defineCoreModule({
        id: 'alpha',
        setup: (ctx) => {
          ctx.services.provide(token, { v: 42 })
        },
      }),
      defineCoreModule({
        id: 'beta',
        dependsOn: ['alpha'],
        setup: (ctx) => {
          got = ctx.services.get(token)
        },
      }),
    ])
    expect(got?.v).toBe(42)
    expect(h.kernel.services.get(token)).toEqual({ v: 42 })
    await h.dispose()
  })

  test('K-4c 服务重复提供 → kernel.conflict', async () => {
    const token = defineServiceToken<{ v: number }>('alpha', 'AlphaService')
    let caught: unknown
    await makeKernel([
      defineCoreModule({
        id: 'alpha',
        setup: (ctx) => {
          ctx.services.provide(token, { v: 1 })
          try {
            ctx.services.provide(token, { v: 2 })
          } catch (e) {
            caught = e
          }
        },
      }),
    ])
    expect((caught as AppError).code).toBe(SystemErrorCode.conflict)
  })

  test('K-4d 获取尚未提供的服务 → kernel.not_found', async () => {
    const token = defineServiceToken<{ v: number }>('alpha', 'AlphaService')
    let caught: unknown
    await makeKernel([
      defineCoreModule({
        id: 'alpha',
        setup: (ctx) => {
          try {
            ctx.services.get(token)
          } catch (e) {
            caught = e
          }
        },
      }),
    ])
    expect((caught as AppError).code).toBe(SystemErrorCode.notFound)
  })

  test('K-5 ready 之前收到的请求回 kernel.core_unavailable', async () => {
    const { RpcPeer } = await import('@poietica/rpc')
    const { composeContracts } = await import('@poietica/contract-kit')
    const { createFakeEngine } = await import('@poietica/engine-testkit')
    const { createTestLogger, fakeClock, tempDir, transportPair } = await import('@poietica/test-kit')
    const { createCoreKernel } = await import('../kernel')
    const { memoryLayout } = await import('../testing/memory-layout')
    const dir = await tempDir('core-kernel-')
    const [coreSide, hostSide] = transportPair()
    let release: () => void = () => undefined
    const gate = new Promise<void>((r) => {
      release = r
    })
    const kernel = createCoreKernel({
      modules: [
        defineCoreModule({
          id: 'alpha',
          contract: alphaContract,
          async setup(ctx) {
            handleAlpha(ctx as never)
            await gate
          },
        }),
      ],
      engine: createFakeEngine(),
      databaseFile: ':memory:',
      layout: memoryLayout(dir.path),
      logger: createTestLogger(),
      clock: fakeClock(),
      transport: coreSide,
      appContract: composeContracts(alphaContract),
      protocolVersion: 1,
      coreVersion: 'x',
      engineVersion: 'y',
      strict: true,
      runtime: { scrubbedEnvKeys: [], setLogLevel: () => undefined },
    })
    const starting = kernel.start()
    const hostPeer = new RpcPeer({ name: 'probe', transport: hostSide, logger: createTestLogger() })
    try {
      await hostPeer.request('alpha.ping', { n: 1 })
      throw new Error('应当抛错')
    } catch (e) {
      expect((e as AppError).code).toBe(SystemErrorCode.coreUnavailable)
      expect((e as AppError).message).toContain('starting')
    }
    release()
    await starting
    expect((await hostPeer.request('alpha.ping', { n: 3 })) as unknown).toEqual({ n: 3 })
    await kernel.shutdown('done')
    hostPeer.dispose()
    await dir.dispose()
  })

  test('K-6 core.shutdown 请求：先回答 {}，再执行关闭', async () => {
    const { RpcPeer } = await import('@poietica/rpc')
    const { composeContracts } = await import('@poietica/contract-kit')
    const { createFakeEngine } = await import('@poietica/engine-testkit')
    const { createTestLogger, fakeClock, tempDir, transportPair } = await import('@poietica/test-kit')
    const { createCoreKernel } = await import('../kernel')
    const { memoryLayout } = await import('../testing/memory-layout')
    const dir = await tempDir('core-kernel-')
    const [coreSide, hostSide] = transportPair()
    const order: string[] = []
    const kernel = createCoreKernel({
      modules: [
        defineCoreModule({
          id: 'alpha',
          contract: alphaContract,
          setup: (ctx) => {
            handleAlpha(ctx as never)
            ctx.lifecycle.onShutdown(() => {
              order.push('hook')
            })
          },
        }),
      ],
      engine: createFakeEngine(),
      databaseFile: ':memory:',
      layout: memoryLayout(dir.path),
      logger: createTestLogger(),
      clock: fakeClock(),
      transport: coreSide,
      appContract: composeContracts(alphaContract),
      protocolVersion: 1,
      coreVersion: 'x',
      engineVersion: 'y',
      strict: true,
      runtime: { scrubbedEnvKeys: [], setLogLevel: () => undefined },
    })
    await kernel.start()
    const exits: number[] = []
    kernel.onExit((c) => exits.push(c))
    const hostPeer = new RpcPeer({ name: 'probe', transport: hostSide, logger: createTestLogger() })
    const reply = await hostPeer.request('core.shutdown', {})
    expect(reply).toEqual({})
    await new Promise((r) => setTimeout(r, 20))
    expect(order).toEqual(['hook'])
    expect(exits).toEqual([0])
    hostPeer.dispose()
    await dir.dispose()
  })

  test('K-8 strict：handler 返回值不符合 result schema → kernel.internal', async () => {
    const h = await makeKernel([alphaModule()])
    try {
      await h.client.call('alpha.badResult', {})
      throw new Error('应当抛错')
    } catch (e) {
      expect((e as AppError).code).toBe(SystemErrorCode.internal)
      expect((e as AppError).message).toContain('不符合契约')
    }
    await h.dispose()
  })

  test('K-8b 非 strict 时不做结果校验', async () => {
    const h = await makeKernel([alphaModule()], { strict: false })
    expect(await h.request('alpha.badResult', {})).toEqual({ ok: 'yes' })
    await h.dispose()
  })

  /*
   * 铁律 5 的兜底：handler 抛的**不是 AppError** 时（B/C 两类漏网、或第三方库抛的），
   * 调用方收到的一定是 kernel.internal，而原始 stack 必须留在日志里 ——
   * 折成 AppError 会换掉 Error 实例，不留这一手就查不到是哪一行抛的。
   */
  test('K-11 handler 抛非 AppError → 调用方收到 kernel.internal，日志保留原始 stack', async () => {
    const h = await makeKernel([alphaModule()])
    try {
      await h.client.call('alpha.rawThrow', {})
      throw new Error('应当抛错')
    } catch (e) {
      expect((e as AppError).code).toBe(SystemErrorCode.internal)
      expect((e as AppError).message).toContain('handler 里抛的裸错误')
    }
    const failure = h.log.records.find((r) => r.level === 'error' && r.msg === 'request failed')
    expect(failure).toBeDefined()
    expect(String(failure?.data.stack ?? '')).toContain('handler 里抛的裸错误')
    await h.dispose()
  })

  /* invariant() 抛的 InvariantError 走同一条兜底（它就是 B 类的标准出口） */
  test('K-11b handler 抛 InvariantError → 同样折成 kernel.internal', async () => {
    const h = await makeKernel([alphaModule()])
    try {
      await h.client.call('alpha.invariantThrow', {})
      throw new Error('应当抛错')
    } catch (e) {
      expect((e as AppError).code).toBe(SystemErrorCode.internal)
    }
    await h.dispose()
  })

  test('业务错误原样透传给调用方', async () => {
    const h = await makeKernel([alphaModule()])
    try {
      await h.client.call('alpha.explode', {})
      throw new Error('应当抛错')
    } catch (e) {
      expect((e as AppError).code).toBe('alpha.boom')
    }
    await h.dispose()
  })

  test('HostCaller：Core 调 owner=host 的方法', async () => {
    const h = await makeKernel([alphaModule()], {
      hostHandlers: { 'gamma.pong': () => ({ pong: 'hi' }) },
    })
    const r = await h.client.call('alpha.callHost', {})
    expect(r.pong).toBe('hi')
    await h.dispose()
  })

  test('HostCaller：调 owner=core 的方法 → kernel.method_not_found', async () => {
    let caught: unknown
    await makeKernel(
      [
        defineCoreModule({
          id: 'alpha',
          contract: alphaContract,
          setup: async (ctx) => {
            handleAlpha(ctx as never)
            try {
              await ctx.host.call(alphaContract, 'alpha.ping', { n: 1 })
            } catch (e) {
              caught = e
            }
          },
        }),
      ],
      { hostHandlers: {} },
    )
    expect((caught as AppError).code).toBe(SystemErrorCode.methodNotFound)
  })

  test('K-9 setup 之后注册 agent 工具 → kernel.conflict', async () => {
    let caught: unknown
    const h = await makeKernel([
      defineCoreModule({
        id: 'alpha',
        setup: (ctx) => {
          ctx.lifecycle.onReady(() => {
            ctx.agentTools.register({
              name: 'alpha_tool',
              label: '工具',
              description: 'x',
              parameters: z.object({}),
              approval: 'read',
              execute: async () => ({ text: 'ok' }),
            })
          })
        },
      }),
    ])
    // onReady 钩子里的抛错被内核捕获 → core.notice + error 日志
    expect(h.received.some((r) => r.method === 'core.notice')).toBe(true)
    expect(h.log.at('error').some((r) => r.msg === 'onReady hook failed')).toBe(true)
    // 直接调用注册接口验证冻结后的行为
    const tool = {
      name: 'alpha_tool2',
      label: '工具',
      description: 'x',
      parameters: z.object({}),
      approval: 'read' as const,
      execute: async () => ({ text: 'ok' }),
    }
    const frozen = await (async () => {
      const { createAgentToolRegistry } = await import('../agent-tools')
      const { createFakeEngine } = await import('@poietica/engine-testkit')
      const registry = createAgentToolRegistry(createFakeEngine(), 'alpha', () => true)
      try {
        registry.register(tool)
        return false
      } catch (e) {
        caught = e
        return true
      }
    })()
    expect(frozen).toBe(true)
    expect(caught).toBeInstanceOf(AppError)
    expect((caught as AppError).code).toBe(SystemErrorCode.conflict)
    await h.dispose()
  })

  test('K-9b setup 期间注册工具；名字不合法 → kernel.invalid_params', async () => {
    let caught: unknown
    const h = await makeKernel([
      defineCoreModule({
        id: 'alpha',
        setup: (ctx) => {
          ctx.agentTools.register({
            name: 'alpha_tool',
            label: '工具',
            description: 'x',
            parameters: z.object({}),
            approval: 'read',
            execute: async () => ({ text: 'ok' }),
          })
          try {
            ctx.agentTools.register({
              name: 'BAD-name',
              label: 'x',
              description: 'x',
              parameters: z.object({}),
              approval: 'read',
              execute: async () => ({ text: '' }),
            })
          } catch (e) {
            caught = e
          }
        },
      }),
    ])
    expect((caught as AppError).code).toBe(SystemErrorCode.invalidParams)
    await h.dispose()
  })

  test('K-10 core.ready 载荷与参数一致', async () => {
    const h = await makeKernel([])
    expect(h.received.find((r) => r.method === 'core.ready')?.params).toEqual({
      coreVersion: '1.2.3',
      protocolVersion: 7,
      engineVersion: '18.5.0',
    })
    await h.dispose()
  })

  test('start() 只能调用一次', async () => {
    const h = await makeKernel([])
    await expect(h.kernel.start()).rejects.toThrow(/只能调用一次/)
    await h.dispose()
  })

  test('模块依赖成环 → kernel.module_graph_invalid', async () => {
    const h = await makeKernel(
      [
        defineCoreModule({ id: 'alpha', dependsOn: ['beta'], setup: () => undefined }),
        defineCoreModule({ id: 'beta', dependsOn: ['alpha'], setup: () => undefined }),
      ],
      { start: false },
    )
    await h.kernel.start().catch((e: unknown) => {
      expect((e as AppError).code).toBe(SystemErrorCode.moduleGraphInvalid)
      expect((e as AppError).message).toContain('成环')
    })
    await h.dispose()
  })

  test('模块契约 id 与模块 id 不一致 → kernel.module_graph_invalid', async () => {
    const h = await makeKernel([defineCoreModule({ id: 'beta', contract: alphaContract, setup: () => undefined })], {
      start: false,
    })
    await h.kernel.start().catch((e: unknown) => {
      expect((e as AppError).code).toBe(SystemErrorCode.moduleGraphInvalid)
      expect((e as AppError).message).toContain('二者必须相同')
    })
    await h.dispose()
  })

  test('模块契约没有被 protocol 汇总 → kernel.module_graph_invalid', async () => {
    const other = defineContract({
      id: 'delta',
      namespaces: ['delta'],
      methods: [],
      notifications: [],
      errors: defineErrors('delta', {}),
    })
    const h = await makeKernel([defineCoreModule({ id: 'delta', contract: other, setup: () => undefined })], {
      start: false,
    })
    await h.kernel.start().catch((e: unknown) => {
      expect((e as AppError).code).toBe(SystemErrorCode.moduleGraphInvalid)
      expect((e as AppError).message).toContain('没有被 @poietica/protocol 汇总')
    })
    await h.dispose()
  })

  test('onReady 钩子抛错只记 error 并发 core.notice，不阻止启动', async () => {
    const h = await makeKernel([
      defineCoreModule({
        id: 'alpha',
        setup: (ctx) => {
          ctx.lifecycle.onReady(() => {
            throw new Error('坏了')
          })
        },
      }),
    ])
    expect(h.received.some((r) => r.method === 'core.notice')).toBe(true)
    expect(h.log.at('error').some((r) => r.msg === 'onReady hook failed')).toBe(true)
    await h.dispose()
  })

  test('K-7 onShutdown 钩子永不返回：超时后继续并记 warn', async () => {
    const h = await makeKernel([
      defineCoreModule({
        id: 'alpha',
        setup: (ctx) => {
          ctx.lifecycle.onShutdown(() => new Promise<void>(() => undefined))
        },
      }),
    ])
    const done = h.kernel.shutdown('stuck')
    // 5 秒超时后必须收尾（关停预算走注入的假时钟）
    await h.clock.advanceAsync(5_000)
    await done
    expect(h.log.at('warn').some((r) => r.msg === 'onShutdown hook failed')).toBe(true)
    await h.dispose()
  })

  /*
   * R-05 §3.3（M5）：关停有**总预算**。旧代码每个钩子各给 5 秒且没有总上限，
   * N 个卡住的模块就是 N×5 秒，远超 Host 的宽限期 —— 结果是被 killTree 半途杀掉。
   *
   * 新语义：8 秒总预算；第一个钩子吃掉 5 秒，第二个只剩 3 秒；engine.dispose
   * 之后 `db.close()` 与 `peer.dispose()` 在 finally 里照常执行。
   * 判据用假时钟推进，总耗时按 clock.now() 算。
   */
  test('R-05 M5 关停总预算：钩子按剩余预算放弃，db 与 engine 仍收尾', async () => {
    const { RpcPeer } = await import('@poietica/rpc')
    const { composeContracts } = await import('@poietica/contract-kit')
    const { createFakeEngine } = await import('@poietica/engine-testkit')
    const { createTestLogger, fakeClock, tempDir, transportPair } = await import('@poietica/test-kit')
    const { rmSync } = await import('node:fs')
    const path = await import('node:path')
    const { createCoreKernel } = await import('../kernel')
    const { memoryLayout } = await import('../testing/memory-layout')
    const { CORE_SHUTDOWN_BUDGET_MS } = await import('@poietica/runtime-layout')

    const dir = await tempDir('core-kernel-shutdown-')
    const dbFile = path.join(dir.path, 'core.db')
    const [coreSide, hostSide] = transportPair()
    const clock = fakeClock()
    const log = createTestLogger()
    const engine = createFakeEngine()
    let engineDisposed = false
    const realDispose = engine.dispose.bind(engine)
    engine.dispose = async () => {
      engineDisposed = true
      await realDispose()
    }
    const abandoned: string[] = []
    const kernel = createCoreKernel({
      modules: ['alpha', 'beta', 'gamma'].map((id, at) =>
        defineCoreModule({
          id,
          // 三个模块的钩子都永不返回；beta 依赖 alpha，避免只做无依赖的并列图
          dependsOn: at === 2 ? ['alpha'] : undefined,
          setup: (ctx) => {
            ctx.lifecycle.onShutdown(() => {
              abandoned.push(id)
              return new Promise<void>(() => undefined)
            })
          },
        }),
      ),
      engine,
      databaseFile: dbFile,
      layout: memoryLayout(dir.path),
      logger: log,
      clock,
      transport: coreSide,
      // 三个模块都没有契约：只要 system 契约，owner='core' 的 core.shutdown 由内核自己答
      appContract: composeContracts(),
      protocolVersion: 1,
      coreVersion: 'x',
      engineVersion: 'y',
      strict: true,
      runtime: { scrubbedEnvKeys: [], setLogLevel: () => undefined },
    })
    await kernel.start()
    const hostPeer = new RpcPeer({ name: 'probe', transport: hostSide, logger: createTestLogger() })
    const exits: number[] = []
    kernel.onExit((c) => exits.push(c))

    const t0 = clock.now()
    const done = kernel.shutdown('stuck')
    // 两个 5 秒级别的等待，中间还要让微任务跑：推进一次总预算再多 1 秒，超了就是实现没按预算收
    await clock.advanceAsync(CORE_SHUTDOWN_BUDGET_MS + 1_000)
    await done
    const elapsed = clock.now() - t0
    expect(elapsed).toBeLessThanOrEqual(CORE_SHUTDOWN_BUDGET_MS + 1_000)
    expect(exits).toEqual([0])
    expect(engineDisposed).toBe(true)
    /*
     * 三个钩子的预算账（逆拓扑序）：gamma 吃满 5 秒被放弃；beta 只剩 3 秒也被放弃；
     * 到 alpha 时预算耗尽 —— 直接跳过（不执行），不是「执行了然后超时」。
     */
    expect(abandoned).toEqual(['gamma', 'beta'])
    expect(log.at('warn').filter((r) => r.msg === 'onShutdown hook failed').length).toBe(2)
    expect(log.at('warn').filter((r) => r.msg === 'shutdown budget exhausted, skipping hook').length).toBe(1)

    // db.close() 真的执行过：Windows 上没关的 SQLite 文件删不掉（EBUSY）
    expect(() => rmSync(dbFile)).not.toThrow()
    hostPeer.dispose()
    await dir.dispose()
  })

  test('transport 关闭触发 shutdown', async () => {
    const h = await makeKernel([])
    const exits: number[] = []
    h.kernel.onExit((c) => exits.push(c))
    /* Host 侧断开连接（关窗、崩溃）后 Core 必须自己退出，不能变成孤儿进程。 */
    h.closeTransport()
    await new Promise((r) => setTimeout(r, 20))
    expect(exits).toEqual([0])
    await h.dispose()
  })

  test('shutdown 后再次 shutdown 是幂等的', async () => {
    const h = await makeKernel([])
    const exits: number[] = []
    h.kernel.onExit((c) => exits.push(c))
    await h.kernel.shutdown('one')
    await h.kernel.shutdown('two')
    expect(exits).toEqual([0])
    await h.dispose()
  })
})
