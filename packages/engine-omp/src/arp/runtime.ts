import type { Logger } from '@poietica/foundation'
import type { Transport } from '@poietica/rpc'
import { createRuntimeKernel, type RuntimeKernel } from '@poietica/runtime-kernel'
import type { AgentEngine, ArpPolicyCheckParams, ArpPolicyDecision } from '@poietica/runtime-protocol'
import { arpMethods, arpPolicyDecision, arpPortEventMethod } from '@poietica/runtime-protocol'
import { installPolicyBridge } from '../session/policy-gate'
import { createArpHandlers } from './handlers'

interface PolicyInstallable {
  setPolicyCheck(check: (request: ArpPolicyCheckParams) => Promise<ArpPolicyDecision>): void
}

/** 只有真实 omp 引擎接受宿主策略；FakeEngine 保持原样。 */
function installsPolicy(engine: object): engine is PolicyInstallable {
  return 'setPolicyCheck' in engine && typeof engine.setPolicyCheck === 'function'
}

/** 把一个 AgentEngine 装成 ARP Worker；进程入口只负责建引擎、取 stdio 传输再调这里。 */
export function createOmpRuntimeWorker(o: {
  readonly engine: AgentEngine
  readonly transport: Transport
  readonly logger: Logger
  readonly info: { readonly runtimeVersion: string; readonly engineVersion: string }
  readonly onShutdown?: () => void
}): { readonly kernel: RuntimeKernel; readonly dispose: () => Promise<void> } {
  installPolicyBridge()
  let kernel: RuntimeKernel
  const arp = createArpHandlers({
    engine: o.engine,
    emit: (p) => kernel.peer.notify('runtime.event', p),
    callCore: (method, params) => kernel.peer.request(method, params),
  })
  kernel = createRuntimeKernel({
    transport: o.transport,
    logger: o.logger,
    info: o.info,
    handlers: arp.handlers,
    ...(o.onShutdown === undefined ? {} : { onShutdown: o.onShutdown }),
  })
  const engine = o.engine
  if (installsPolicy(engine)) {
    engine.setPolicyCheck(async (request) =>
      arpPolicyDecision.parse(await kernel.peer.request(arpMethods.policyCheck, request)),
    )
  }
  const subscriptions = [
    o.engine.models.onDidChange(() => kernel.peer.notify(arpPortEventMethod, { port: 'models', event: 'change' })),
    o.engine.models.onDidChangeDefaults(() =>
      kernel.peer.notify(arpPortEventMethod, { port: 'models', event: 'defaults' }),
    ),
    o.engine.settings.onDidChange((data) =>
      kernel.peer.notify(arpPortEventMethod, { port: 'settings', event: 'change', data }),
    ),
    o.engine.mcp.onDidChangeStatus((data) =>
      kernel.peer.notify(arpPortEventMethod, { port: 'mcp', event: 'status', data }),
    ),
  ]
  return {
    kernel,
    async dispose() {
      for (const subscription of subscriptions) subscription.dispose()
      await arp.dispose()
      kernel.peer.dispose()
    },
  }
}
