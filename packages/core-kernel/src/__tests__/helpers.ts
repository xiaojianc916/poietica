import {
  composeContracts,
  defineContract,
  defineErrors,
  defineMethod,
  defineNotification,
} from '@poietica/contract-kit'
import { createFakeEngine } from '@poietica/engine-testkit'
import { AppError, invariant } from '@poietica/foundation'
import { createTypedClient, RpcPeer, type TypedRpcClient } from '@poietica/rpc'
import { createTestLogger, fakeClock, type TestLogger, tempDir, transportPair } from '@poietica/test-kit'
import { z } from 'zod'
import { type CoreKernel, createCoreKernel } from '../kernel'
import type { CoreModule } from '../module'
import { memoryLayout } from '../testing/memory-layout'

export const alphaErrors = defineErrors('alpha', { boom: '炸了' })
const empty = z.object({})

export const alphaContract = defineContract({
  id: 'alpha',
  namespaces: ['alpha'],
  methods: [
    defineMethod({
      name: 'alpha.ping',
      owner: 'core',
      params: z.object({ n: z.number().int() }),
      result: z.object({ n: z.number().int() }),
      description: '回显 n',
    }),
    defineMethod({
      name: 'alpha.explode',
      owner: 'core',
      params: empty,
      result: empty,
      description: '总是抛 alpha.boom',
    }),
    defineMethod({
      name: 'alpha.badResult',
      owner: 'core',
      params: empty,
      result: z.object({ ok: z.boolean() }),
      description: '返回不符合契约的值',
    }),
    defineMethod({
      name: 'alpha.rawThrow',
      owner: 'core',
      params: empty,
      result: empty,
      description: '抛一个不是 AppError 的原生错误（K-11）',
    }),
    defineMethod({
      name: 'alpha.invariantThrow',
      owner: 'core',
      params: empty,
      result: empty,
      description: '抛 invariant()（K-11b）',
    }),
    defineMethod({
      name: 'alpha.callHost',
      owner: 'core',
      params: empty,
      result: z.object({ pong: z.string() }),
      description: '调用 Host 方法',
    }),
    defineMethod({
      name: 'alpha.neverHandled',
      owner: 'core',
      params: empty,
      result: empty,
      description: '故意不实现',
    }),
  ],
  notifications: [
    defineNotification({
      name: 'alpha.tick',
      owner: 'core',
      params: z.object({ n: z.number().int() }),
      description: '计数',
    }),
    defineNotification({
      name: 'alpha.badTick',
      owner: 'core',
      params: z.object({ s: z.string() }),
      description: '参数不符合契约的通知',
    }),
  ],
  errors: alphaErrors,
})

export const hostContract = defineContract({
  id: 'gamma',
  namespaces: ['gamma'],
  methods: [
    defineMethod({
      name: 'gamma.pong',
      owner: 'host',
      params: empty,
      result: z.object({ pong: z.string() }),
      description: 'Host 侧应答',
    }),
  ],
  notifications: [],
  errors: defineErrors('gamma', {}),
})

type LooseRpc = {
  handle(name: string, fn: (params: never, ctx: never) => unknown): unknown
  emit(name: string, params: unknown): void
}

/** 用宽松类型注册 alphaContract 的全部处理器；neverHandled 也可由调用方选择跳过 */
export function handleAlpha(ctx: { rpc: unknown; host?: unknown }, skip?: readonly string[]): void {
  const rpc = ctx.rpc as LooseRpc
  const want = (name: string): boolean => !(skip ?? []).includes(name)
  if (want('alpha.ping')) rpc.handle('alpha.ping', (p) => ({ n: (p as unknown as { n: number }).n }))
  if (want('alpha.explode')) {
    rpc.handle('alpha.explode', () => {
      throw new AppError(alphaErrors.boom, '炸了')
    })
  }
  if (want('alpha.badResult')) rpc.handle('alpha.badResult', () => ({ ok: 'yes' }))
  if (want('alpha.rawThrow')) {
    /* 刻意抛原生 Error：K-11 验的是「非 AppError 一律折成 kernel.internal 且日志留 stack」 */
    rpc.handle('alpha.rawThrow', () => {
      throw new Error('handler 里抛的裸错误')
    })
  }
  if (want('alpha.invariantThrow')) {
    rpc.handle('alpha.invariantThrow', () => {
      invariant(false, 'handler 里抛的不变量')
    })
  }
  if (want('alpha.callHost')) {
    rpc.handle('alpha.callHost', async () => {
      const host = ctx.host as {
        call(contract: unknown, name: string, params: unknown): Promise<unknown>
      }
      return (await host.call(hostContract, 'gamma.pong', {})) as { pong: string }
    })
  }
  if (want('alpha.neverHandled')) rpc.handle('alpha.neverHandled', () => ({}))
}

export function alphaModule(skip?: readonly string[]) {
  return {
    id: 'alpha',
    contract: alphaContract,
    setup: (ctx: unknown) => {
      handleAlpha(ctx as never, skip)
    },
  }
}

export interface KernelHarness {
  readonly kernel: CoreKernel
  readonly client: TypedRpcClient<typeof alphaContract>
  readonly log: TestLogger
  readonly clock: ReturnType<typeof fakeClock>
  readonly received: Array<{ method: string; params: unknown }>
  readonly failed: boolean
  /** 绕过类型化客户端（不做结果校验）直接发请求 */
  request(method: string, params: unknown): Promise<unknown>
  notifications(name: string): unknown[]
  /** 关掉 Host 侧的传输：验证「Host 断开 → Core 自行关闭」 */
  closeTransport(): void
  dispose(): Promise<void>
}

export interface MakeKernelOptions {
  readonly strict?: boolean
  readonly hostHandlers?: Readonly<Record<string, (params: unknown) => unknown>>
  readonly start?: boolean
}

export async function makeKernel(modules: readonly CoreModule[], opts: MakeKernelOptions = {}): Promise<KernelHarness> {
  const dir = await tempDir('core-kernel-')
  const clock = fakeClock()
  const log = createTestLogger()
  const [coreSide, hostSide] = transportPair()
  const appContract = composeContracts(...modules.flatMap((m) => (m.contract === undefined ? [] : [m.contract])))
  const received: Array<{ method: string; params: unknown }> = []
  const listeners = new Set<(m: { method: string; params: unknown }) => void>()
  const hostPeer = new RpcPeer({
    name: 'test-host',
    transport: hostSide,
    logger: createTestLogger(),
    onNotification: (method, params) => {
      const m = { method, params }
      received.push(m)
      for (const l of [...listeners]) l(m)
    },
    onRequest: async (method, params) => {
      const h = opts.hostHandlers?.[method]
      if (h === undefined) throw new Error(`测试未提供 Host 方法 ${method} 的应答`)
      return h(params)
    },
  })
  const kernel = createCoreKernel({
    modules,
    engine: createFakeEngine(),
    databaseFile: ':memory:',
    layout: memoryLayout(dir.path),
    logger: log,
    clock,
    transport: coreSide,
    appContract,
    protocolVersion: 7,
    coreVersion: '1.2.3',
    engineVersion: '18.5.0',
    strict: opts.strict ?? true,
    runtime: { scrubbedEnvKeys: ['OPENAI_API_KEY'], setLogLevel: () => undefined },
  })
  const channel = {
    request: (method: string, params: unknown, o: { timeoutMs?: number; signal?: AbortSignal }) =>
      hostPeer.request(method, params, o),
    subscribe: (name: string, listener: (params: unknown) => void) => {
      const l = (m: { method: string; params: unknown }): void => {
        if (m.method === name) listener(m.params)
      }
      listeners.add(l)
      return {
        dispose: () => {
          listeners.delete(l)
        },
      }
    },
  }
  let failed = false
  if (opts.start !== false) {
    try {
      await kernel.start()
      await new Promise((r) => setTimeout(r, 5))
    } catch {
      failed = true
    }
  }
  return {
    kernel,
    log,
    clock,
    received,
    failed,
    request: (method, params) => hostPeer.request(method, params, { timeoutMs: 5_000 }),
    client: createTypedClient(alphaContract, channel, { validateResults: true }),
    notifications: (name) => received.filter((n) => n.method === name).map((n) => n.params),
    closeTransport: () => hostSide.close('test host closed'),
    async dispose() {
      await kernel.shutdown('test')
      hostPeer.dispose()
      await dir.dispose()
    },
  }
}
