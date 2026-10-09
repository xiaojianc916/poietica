import { type Contract, composeContracts, type NotificationName, type NotificationParams } from '@poietica/contract-kit'
import type { AgentEngine } from '@poietica/engine'
import { createTypedClient, RpcPeer, type TypedRpcClient } from '@poietica/rpc'
import { createTestLogger, type FakeClock, fakeClock, type TempDir, tempDir, transportPair } from '@poietica/test-kit'
import { type CoreKernel, createCoreKernel } from '../kernel'
import type { CoreModule } from '../module'
import { memoryLayout } from './memory-layout'

export interface CoreHarnessOptions {
  readonly modules: readonly CoreModule[]
  /** 调用方传入：通常是 @poietica/engine-testkit 的 createFakeEngine()；功能包把 engine-testkit 列在 devDependencies */
  readonly engine: AgentEngine
  /** 被测模块调用 Host 方法时的应答：键是方法名 */
  readonly hostHandlers?: Readonly<Record<string, (params: unknown) => unknown>>
  /**
   * 与 FakeEngine 共用的假时钟。省略时内核自己造一个。
   *
   * 为什么要有这一格：FakeEngine 按 12 页 §1.2 用**注入的 Clock** 排下一拍，而内核用另一个
   * 时钟排合批与 TTL。两者不是同一个时钟时，测试推一个推不动另一个 —— 现象是「时间线增量
   * 永远不来、会话永远是 running」。要让时间可控，只能让双方共用同一个 fakeClock。
   */
  readonly clock?: FakeClock
}

export interface CoreHarness {
  readonly kernel: CoreKernel
  readonly clock: FakeClock
  readonly engine: AgentEngine
  readonly dataRoot: string
  client<C extends Contract>(contract: C): TypedRpcClient<C>
  /** 已收到的通知（按到达顺序） */
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
