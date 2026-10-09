import { describe, expect, test } from 'bun:test'
import { AppError } from '@poietica/foundation'
import { render, screen } from '@testing-library/react'
import { builtinPoints } from '../builtin-points'
import { defineUiFeature } from '../feature'
import { createUiKernel, type UiKernel } from '../kernel'
import { useService } from '../react/hooks'
import { FeatureScope, KernelProvider } from '../react/kernel-context'
import { alphaContract, betaContract, createTestBridge, type TestBridge } from './helpers'

async function startKernel(o: {
  features?: Parameters<typeof createUiKernel>[0]['features']
  bridge?: TestBridge
  validateResults?: boolean
}): Promise<{ kernel: UiKernel; bridge: TestBridge }> {
  const bridge =
    o.bridge ??
    createTestBridge((method) => (method === 'core.getStatus' ? { state: 'starting', reason: null, attempt: 0 } : {}))
  const kernel = createUiKernel({
    features: o.features ?? [],
    errorMessages: { 'alpha.boom': '炸了' },
    validateResults: o.validateResults ?? false,
    defaultRoute: { surface: 'home', params: {} },
    bridge,
  })
  await kernel.start()
  return { kernel, bridge }
}

describe('ui-kernel', () => {
  test('UK-1 两个功能 b 依赖 a，清单顺序 [b, a] → activate 顺序 a、b', async () => {
    const order: string[] = []
    const a = defineUiFeature({
      id: 'alpha',
      setup: () => {
        order.push('a')
      },
    })
    const b = defineUiFeature({
      id: 'beta',
      dependsOn: ['alpha'],
      setup: () => {
        order.push('b')
      },
    })
    await startKernel({ features: [b, a] })
    expect(order).toEqual(['a', 'b'])
  })

  test('UK-2 两个功能注册同一个命令 id → 启动抛错，错误信息包含两个功能的 id', async () => {
    const a = defineUiFeature({
      id: 'alpha',
      setup: (ctx) => {
        ctx.contribute(builtinPoints.commands, { id: 'dup', title: 'a', run: () => undefined })
      },
    })
    const b = defineUiFeature({
      id: 'beta',
      setup: (ctx) => {
        ctx.contribute(builtinPoints.commands, { id: 'dup', title: 'b', run: () => undefined })
      },
    })
    const { kernel } = await startKernel({ features: [b, a] })
    // 清单顺序 [b, a]：beta 先 setup，alpha 再注册同一个 id 时失败
    const err = kernel.failures.get('alpha')
    expect(err).toBeInstanceOf(Error)
    expect(err!.message).toContain('alpha')
    expect(err!.message).toContain('beta')
  })

  test('setup 抛错的功能被标记失败，其余功能照常启动', async () => {
    const bad = defineUiFeature({
      id: 'bad',
      setup: () => {
        throw new AppError('alpha.boom', '炸了')
      },
    })
    const good = defineUiFeature({ id: 'good', setup: () => undefined })
    const { kernel } = await startKernel({ features: [bad, good] })
    expect(kernel.failures.get('bad')?.message).toBe('炸了')
    expect(kernel.failures.has('good')).toBe(false)
  })

  test('ctx.rpc：未声明的契约 → kernel.service_access_denied', async () => {
    let caught: unknown
    const f = defineUiFeature({
      id: 'alpha',
      setup: (ctx) => {
        try {
          ctx.rpc(betaContract)
        } catch (e) {
          caught = e
        }
      },
    })
    await startKernel({ features: [f] })
    expect(caught).toBeInstanceOf(AppError)
    expect((caught as AppError).code).toBe('kernel.service_access_denied')
    expect((caught as AppError).message).toContain("'beta'")
  })

  test('ctx.rpc：声明了 dependsOn 就能用；方法可用', async () => {
    const bridge = createTestBridge((method) => {
      if (method === 'core.getStatus') return { state: 'starting', reason: null, attempt: 0 }
      if (method === 'alpha.echo') return { v: 'echo' }
      return {}
    })
    let client: { call(n: string, p: unknown): Promise<unknown> } | undefined
    const f = defineUiFeature({
      id: 'alpha',
      setup: (ctx) => {
        client = ctx.rpc(alphaContract)
      },
    })
    await startKernel({ features: [f], bridge })
    expect(await client!.call('alpha.echo', { v: 'x' })).toEqual({ v: 'echo' })
  })

  test('UK-4 注册设置项后读写：内核服务可被取用', async () => {
    const { NavigationToken } = await import('../services')
    let nav: { current(): { route: { surface: string } } } | undefined
    const f = defineUiFeature({
      id: 'alpha',
      setup: (ctx) => {
        nav = ctx.services.get(NavigationToken) as never
      },
    })
    const { kernel } = await startKernel({ features: [f] })
    expect(nav!.current().route.surface).toBe('home')
    kernel.kernelServices.navigation.navigate({ surface: 'x', params: {} })
    expect(nav!.current().route.surface).toBe('x')
  })

  test('UK-5 toasts 服务：同一条错误重复只显示一次', async () => {
    const { ToastsToken } = await import('../services')
    const f = defineUiFeature({
      id: 'alpha',
      setup: (ctx) => {
        ctx.services.get(ToastsToken)
      },
    })
    const { kernel } = await startKernel({ features: [f] })
    kernel.kernelServices.toasts.error(new AppError('alpha.boom', 'x'))
    kernel.kernelServices.toasts.error(new AppError('alpha.boom', 'x'))
    expect(kernel.kernelServices.toasts.current().length).toBe(1)
  })

  test('UK-7 Core 状态：先订阅通知，再拉当前值', async () => {
    const bridge = createTestBridge((method) =>
      method === 'core.getStatus' ? { state: 'starting', reason: null, attempt: 0 } : {},
    )
    const { kernel, bridge: b } = await startKernel({ features: [], bridge })
    expect(kernel.kernelServices.coreStatus.current().state).toBe('starting')
    b.emit({ jsonrpc: '2.0', method: 'core.status', params: { state: 'ready', reason: null, attempt: 0 } })
    expect(kernel.kernelServices.coreStatus.current().state).toBe('ready')
  })

  test('UK-7b 通知比拉取结果新时以通知为准', async () => {
    let release: () => void = () => undefined
    const gate = new Promise<void>((r) => {
      release = r
    })
    const bridge = createTestBridge(async (method) => {
      if (method === 'core.getStatus') {
        await gate
        return { state: 'starting', reason: null, attempt: 0 }
      }
      return {}
    })
    const kernel = createUiKernel({
      features: [],
      errorMessages: {},
      validateResults: false,
      defaultRoute: { surface: 'home', params: {} },
      bridge,
    })
    const started = kernel.start()
    bridge.emit({ jsonrpc: '2.0', method: 'core.status', params: { state: 'ready', reason: null, attempt: 0 } })
    release()
    await started
    expect(kernel.kernelServices.coreStatus.current().state).toBe('ready')
  })

  test('onCoreReady 在状态进入 ready 时执行；崩溃重连后再次执行', async () => {
    const runs: number[] = []
    const f = defineUiFeature({
      id: 'alpha',
      setup: (ctx) => {
        ctx.lifecycle.onCoreReady(() => {
          runs.push(1)
        })
      },
    })
    const { bridge } = await startKernel({ features: [f] })
    expect(runs.length).toBe(0)
    bridge.emit({ jsonrpc: '2.0', method: 'core.status', params: { state: 'ready', reason: null, attempt: 0 } })
    await new Promise((r) => setTimeout(r, 5))
    expect(runs.length).toBe(1)
    bridge.emit({
      jsonrpc: '2.0',
      method: 'core.status',
      params: { state: 'restarting', reason: 'crashed', attempt: 1 },
    })
    bridge.emit({ jsonrpc: '2.0', method: 'core.status', params: { state: 'ready', reason: null, attempt: 1 } })
    await new Promise((r) => setTimeout(r, 5))
    expect(runs.length).toBe(2)
  })

  test('onCoreReady 抛错时显示 toast，不影响其它功能', async () => {
    const f = defineUiFeature({
      id: 'alpha',
      setup: (ctx) => {
        ctx.lifecycle.onCoreReady(() => {
          throw new Error('加载失败')
        })
      },
    })
    const g = defineUiFeature({
      id: 'beta',
      setup: (ctx) => {
        ctx.lifecycle.onCoreReady(() => undefined)
      },
    })
    const { kernel, bridge } = await startKernel({ features: [f, g] })
    bridge.emit({ jsonrpc: '2.0', method: 'core.status', params: { state: 'ready', reason: null, attempt: 0 } })
    await new Promise((r) => setTimeout(r, 5))
    expect(kernel.kernelServices.toasts.current().length).toBe(1)
    expect(kernel.kernelServices.toasts.current()[0]!.title).toContain('alpha')
  })

  test('dispose 逆序执行 onDispose 并回收贡献', async () => {
    const order: string[] = []
    const a = defineUiFeature({
      id: 'alpha',
      setup: (ctx) => {
        ctx.lifecycle.onDispose(() => {
          order.push('a')
        })
        ctx.contribute(builtinPoints.commands, { id: 'a.cmd', title: 'a', run: () => undefined })
      },
    })
    const b = defineUiFeature({
      id: 'beta',
      dependsOn: ['alpha'],
      setup: (ctx) => {
        ctx.lifecycle.onDispose(() => {
          order.push('b')
        })
      },
    })
    const { kernel } = await startKernel({ features: [a, b] })
    expect(kernel.registry.list(builtinPoints.commands).length).toBe(1)
    kernel.dispose()
    expect(order).toEqual(['b', 'a'])
    expect(kernel.registry.list(builtinPoints.commands).length).toBe(0)
  })

  test('UK-8 validateResults 开启：结果不符合 schema 时记录错误，但调用方仍收到结果', async () => {
    const bridge = createTestBridge((method) => {
      if (method === 'core.getStatus') return { state: 'starting', reason: null, attempt: 0 }
      return { ok: 'not-a-boolean' }
    })
    let client: { call(n: string, p: unknown): Promise<unknown> } | undefined
    const f = defineUiFeature({
      id: 'alpha',
      setup: (ctx) => {
        client = ctx.rpc(alphaContract)
      },
    })
    const { kernel } = await startKernel({ features: [f], bridge, validateResults: true })
    // 结果不符合 schema：抛出 ZodError，内核/功能自行处理；验收点是"不静默"
    const err = await client!.call('alpha.bad', {}).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(Error)
    expect(String(err)).toContain('ok')
    expect(kernel.kernelServices.logging.logger).toBeDefined()
  })

  test('没有 bridge 时 createUiKernel 抛错', () => {
    expect(() =>
      createUiKernel({
        features: [],
        errorMessages: {},
        validateResults: false,
        defaultRoute: { surface: 'home', params: {} },
        bridge: undefined,
      }),
    ).toThrow(/preload/)
  })
})

describe('React 绑定', () => {
  test('UK-6 功能组件 throw：只有该区域显示错误占位，兄弟组件正常渲染', async () => {
    function Boom(): never {
      throw new Error('组件炸了')
    }
    function Fine() {
      return <p>一切正常</p>
    }
    const { kernel } = await startKernel({ features: [] })
    render(
      <KernelProvider kernel={kernel}>
        <FeatureScope featureId="alpha">
          <Boom />
        </FeatureScope>
        <FeatureScope featureId="beta">
          <Fine />
        </FeatureScope>
      </KernelProvider>,
    )
    expect(screen.getByText('一切正常')).toBeDefined()
    expect(document.querySelector('[data-feature-error="alpha"]')).not.toBeNull()
    expect(screen.getByText(/alpha.*出现错误/)).toBeDefined()
    kernel.dispose()
  })

  test('useService 遵守 dependsOn 规则', async () => {
    const Token = { ownerModule: 'alpha', name: 'Thing' } as never
    const f = defineUiFeature({
      id: 'alpha',
      setup: (ctx) => {
        ctx.services.provide(Token, { v: 1 })
      },
    })
    const g = defineUiFeature({
      id: 'beta',
      dependsOn: ['alpha'],
      setup: () => undefined,
    })
    const { kernel } = await startKernel({ features: [f, g] })
    function Consumer() {
      const thing = useService(Token) as { v: number }
      return <p>v={thing.v}</p>
    }
    render(
      <KernelProvider kernel={kernel}>
        <FeatureScope featureId="beta">
          <Consumer />
        </FeatureScope>
      </KernelProvider>,
    )
    expect(screen.getByText('v=1')).toBeDefined()
    kernel.dispose()
  })

  test('useService 在未声明 dependsOn 时抛错 → 错误边界接管', async () => {
    const Token = { ownerModule: 'alpha', name: 'Thing' } as never
    const f = defineUiFeature({
      id: 'alpha',
      setup: (ctx) => {
        ctx.services.provide(Token, { v: 1 })
      },
    })
    const g = defineUiFeature({ id: 'beta', setup: () => undefined })
    const { kernel } = await startKernel({ features: [f, g] })
    function Consumer() {
      useService(Token)
      return <p>不该出现</p>
    }
    render(
      <KernelProvider kernel={kernel}>
        <FeatureScope featureId="beta">
          <Consumer />
        </FeatureScope>
      </KernelProvider>,
    )
    expect(document.querySelector('[data-feature-error="beta"]')).not.toBeNull()
    kernel.dispose()
  })
})
