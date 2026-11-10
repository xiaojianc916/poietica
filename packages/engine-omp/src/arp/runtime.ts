import type { Logger } from '@poietica/foundation'
import type { Transport } from '@poietica/rpc'
import { createRuntimeKernel, type RuntimeKernel } from '@poietica/runtime-kernel'
import type { AgentEngine } from '@poietica/runtime-protocol'
import { arpPortEventMethod } from '@poietica/runtime-protocol'
import { createArpHandlers } from './handlers'

/** 把一个 AgentEngine 装成 ARP Worker；进程入口只负责建引擎、取 stdio 传输再调这里。 */
export function createOmpRuntimeWorker(o: {
  readonly engine: AgentEngine
  readonly transport: Transport
  readonly logger: Logger
  readonly info: { readonly runtimeVersion: string; readonly engineVersion: string }
  readonly onShutdown?: () => void
}): { readonly kernel: RuntimeKernel; readonly dispose: () => Promise<void> } {
  /* Worker 没有 Core 的模块装配期；产品工具经 ARP 注册之前先冻结空表，否则 openSession 会报 tools_frozen。 */
  o.engine.freezeTools()
  let kernel: ReturnType<typeof createRuntimeKernel>
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
