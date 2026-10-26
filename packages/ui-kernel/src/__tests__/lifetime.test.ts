import { describe, expect, test } from 'bun:test'
import { Deferred, defineServiceToken } from '@poietica/foundation'
import { builtinPoints } from '../builtin-points'
import { defineUiFeature, type UiFeature } from '../feature'
import { createUiKernel } from '../kernel'
import { createTestBridge, type TestBridge } from './helpers'

const status = (bridge: TestBridge, state: 'ready' | 'restarting'): void => {
  bridge.emit({ jsonrpc: '2.0', method: 'core.status', params: { state, reason: null, attempt: 0 } })
}
const flush = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

async function start(features: readonly UiFeature[]) {
  const bridge = createTestBridge(() => ({ state: 'starting', reason: null, attempt: 0 }))
  const kernel = createUiKernel({
    features,
    bridge,
    errorMessages: {},
    validateResults: false,
    defaultRoute: { surface: 'home', params: {} },
  })
  await kernel.start()
  return { kernel, bridge }
}

describe('功能生命周期边界', () => {
  test('setup 中途失败：立即回收贡献、服务与订阅，依赖方不再启动', async () => {
    const token = defineServiceToken<number>('alpha', 'Value')
    const calls: string[] = []
    const { kernel } = await start([
      defineUiFeature({
        id: 'alpha',
        setup(ctx) {
          ctx.services.provide(token, 1)
          ctx.contribute(builtinPoints.commands, { id: 'alpha.cmd', title: 'alpha', run: () => undefined })
          ctx.lifecycle.onDispose(() => calls.push('cleanup'))
          throw new Error('装配中断')
        },
      }),
      defineUiFeature({ id: 'beta', dependsOn: ['alpha'], setup: () => calls.push('beta') }),
      defineUiFeature({ id: 'gamma', dependsOn: ['beta'], setup: () => calls.push('gamma') }),
      defineUiFeature({ id: 'delta', setup: () => calls.push('delta') }),
    ])
    try {
      expect(calls).toEqual(['cleanup', 'delta'])
      expect(kernel.registry.list(builtinPoints.commands)).toEqual([])
      expect(() => kernel.servicesFor('alpha').tryGet(token)).toThrow('已撤销')
      expect([...kernel.failures.keys()]).toEqual(['alpha', 'beta', 'gamma'])
    } finally {
      kernel.dispose()
    }
    expect(calls).toEqual(['cleanup', 'delta'])
  })

  test('dispose 幂等：清理钩子抛错不挡其余资源回收', async () => {
    const calls: string[] = []
    const { kernel } = await start([
      defineUiFeature({
        id: 'alpha',
        setup(ctx) {
          ctx.lifecycle.onDispose(() => calls.push('first'))
          ctx.lifecycle.onDispose(() => {
            calls.push('throw')
            throw new Error('释放失败')
          })
          ctx.contribute(builtinPoints.commands, { id: 'alpha.cmd', title: 'alpha', run: () => undefined })
        },
      }),
    ])
    kernel.dispose()
    kernel.dispose()
    expect(calls).toEqual(['throw', 'first'])
    expect(kernel.registry.list(builtinPoints.commands)).toEqual([])
  })

  test.each(['lost', 'dispose'] as const)('%s 后旧 ready 链不再启动后续钩子', async (end) => {
    const gate = new Deferred<void>()
    const calls: string[] = []
    const { kernel, bridge } = await start([
      defineUiFeature({
        id: 'alpha',
        setup(ctx) {
          ctx.lifecycle.onCoreReady(async () => {
            calls.push('first')
            await gate.promise
          })
          ctx.lifecycle.onCoreReady(() => {
            calls.push('second')
          })
        },
      }),
    ])
    try {
      status(bridge, 'ready')
      if (end === 'lost') status(bridge, 'restarting')
      else kernel.dispose()
      gate.resolve()
      await flush()
      expect(calls).toEqual(['first'])
    } finally {
      gate.resolve()
      kernel.dispose()
    }
  })

  test('旧 ready 钩子的迟到拒绝不产生新一代的错误横幅', async () => {
    const gate = new Deferred<void>()
    const { kernel, bridge } = await start([
      defineUiFeature({
        id: 'alpha',
        setup(ctx) {
          ctx.lifecycle.onCoreReady(() => gate.promise)
        },
      }),
    ])
    try {
      status(bridge, 'ready')
      status(bridge, 'restarting')
      gate.reject(new Error('旧进程已失效'))
      await flush()
      expect(kernel.kernelServices.banners.current()).toEqual([])
    } finally {
      kernel.dispose()
    }
  })
})

test('ready 作用域在丢失和 dispose 时同步中止，新一代拿到独立 signal', async () => {
  const signals: AbortSignal[] = []
  const { kernel, bridge } = await start([
    defineUiFeature({
      id: 'alpha',
      setup(ctx) {
        ctx.lifecycle.onCoreReady(({ signal }) => {
          signals.push(signal)
        })
      },
    }),
  ])
  status(bridge, 'ready')
  expect(signals[0]?.aborted).toBe(false)
  status(bridge, 'restarting')
  expect(signals[0]?.aborted).toBe(true)
  status(bridge, 'ready')
  expect(signals[1]).not.toBe(signals[0])
  expect(signals[1]?.aborted).toBe(false)
  kernel.dispose()
  expect(signals[1]?.aborted).toBe(true)
})

test('启动不能重入，也不能在 dispose 后重新启动', async () => {
  const { kernel } = await start([])
  await expect(kernel.start()).rejects.toThrow('只能启动一次')
  kernel.dispose()
  await expect(kernel.start()).rejects.toThrow('只能启动一次')
})
