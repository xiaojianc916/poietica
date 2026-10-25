import { type Contract, composeContracts, type NotificationName, type NotificationParams } from '@poietica/contract-kit'
import type { AgentEngine } from '@poietica/engine'
import { createTypedClient, RpcPeer, type TypedRpcClient } from '@poietica/rpc'
import { transportPair } from '@poietica/rpc/testing'
import { createTestLogger, type FakeClock, fakeClock, type TempDir, tempDir } from '@poietica/test-kit'
import { type CoreKernel, createCoreKernel } from '../kernel'
import type { CoreModule } from '../module'
import { memoryLayout } from './memory-layout'

export interface CoreHarnessOptions {
  readonly modules: readonly CoreModule[]
  /** 通常是 @poietica/engine-testkit 的 createFakeEngine()；功能包把 engine-testkit 列在 devDependencies。 */
  readonly engine: AgentEngine
  readonly hostHandlers?: Readonly<Record<string, (params: unknown) => unknown>>
  /**
   * 与 FakeEngine 共用的假时钟。两者不是同一个时钟时，测试推一个推不动另一个 ——
   * 现象是「时间线增量永远不来、会话永远是 running」。
   */
  readonly clock?: FakeClock
}

export interface CoreHarness {
  readonly kernel: CoreKernel
  readonly clock: FakeClock
  readonly engine: AgentEngine
  readonly dataRoot: string
  client<C extends Contract>(contract: C): TypedRpcClient<C>
  notifications<C extends Contract, N extends NotificationName<C>>(contract: C, name: N): NotificationParams<C, N>[]
  dispose(): Promise<void>
}

export async function createCoreHarness(opts: CoreHarnessOptions): Promise<CoreHarness> {
  const dir: TempDir = await tempDir('core-harness-')
  const clock = opts.clock ?? fakeClock()
  const engine = opts.engine
  const [coreSide, hostSide] = transportPair()
  const contracts = opts.modules.flatMap((m) => (m.contract === undefined ? [] : [m.contract]))
  const appContract = composeContracts(...contracts)
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
    modules: opts.modules,
    engine,
    databaseFile: ':memory:',
    layout: memoryLayout(dir.path),
    logger: createTestLogger(),
    clock,
    transport: coreSide,
    appContract,
    protocolVersion: 0,
    coreVersion: 'test',
    engineVersion: 'test',
    strict: true,
    runtime: { scrubbedEnvKeys: [], setLogLevel: () => undefined },
  })
  await kernel.start()
  return {
    kernel,
    clock,
    engine,
    dataRoot: dir.path,
    client: (contract) =>
      createTypedClient(
        contract,
        {
          request: (method, params, o) => hostPeer.request(method, params, o),
          subscribe: (name, listener) => {
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
        },
        { validateResults: true },
      ),
    notifications: (contract, name) =>
      received
        .filter((n) => n.method === name)
        .map((n) => contract.notifications.find((d) => d.name === name)!.params.parse(n.params)) as never,
    async dispose() {
      await kernel.shutdown('test done')
      hostPeer.dispose()
      await dir.dispose()
    },
  }
}
