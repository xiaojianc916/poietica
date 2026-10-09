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

  test('K-7 onShutdown 钩子永不返回：超时后继续并记 warn（真实时钟 5 秒）', async () => {
    const h = await makeKernel([
      defineCoreModule({
        id: 'alpha',
        setup: (ctx) => {
          ctx.lifecycle.onShutdown(() => new Promise<void>(() => undefined))
        },
      }),
    ])
    const done = h.kernel.shutdown('stuck')
    // 5 秒超时后必须收尾：这里给 8 秒余量
    await Promise.race([done, new Promise((r) => setTimeout(r, 8_000))])
    expect(h.log.at('warn').some((r) => r.msg === 'onShutdown hook failed')).toBe(true)
    await h.dispose()
  }, 15_000)

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
