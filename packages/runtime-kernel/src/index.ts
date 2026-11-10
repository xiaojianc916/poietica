import { AppError, type Logger, SystemErrorCode } from '@poietica/foundation'
import { type InboundContext, jsonValue, RpcPeer, type Transport } from '@poietica/rpc'
import {
  ARP_VERSION,
  arpErrors,
  arpHelloParams,
  arpHelloResult,
  arpMethods,
  arpPingResult,
} from '@poietica/runtime-protocol'

/**
 * Runtime Worker 的通用外壳（架构设计 §8、§10）。只做传输、握手、方法查表与关停；
 * 具体会话/Run 方法由各 Worker 注入 handlers，不把 omp 或任何引擎的类型带进来。
 */
export interface RuntimeKernelInfo {
  readonly runtimeVersion: string
  readonly engineVersion: string
}

export type RuntimeHandler = (params: unknown, ctx: InboundContext) => unknown

export interface RuntimeKernelOptions {
  readonly transport: Transport
  readonly logger: Logger
  readonly info: RuntimeKernelInfo
  /** 除握手/生命周期之外的方法；键就是 ARP 方法名。 */
  readonly handlers?: Readonly<Record<string, RuntimeHandler>>
  /** 8.2 表里这一版实际可用的方法组，写进 hello 结果。 */
  readonly capabilities?: readonly string[]
  readonly onShutdown?: (reason: string) => Promise<void> | void
}

export interface RuntimeKernel {
  readonly peer: RpcPeer
  shutdown(reason: string): Promise<void>
}

export function createRuntimeKernel(options: RuntimeKernelOptions): RuntimeKernel {
  let closing: Promise<void> | undefined
  const capabilities = [
    ...new Set([...Object.values(arpMethods), ...Object.keys(options.handlers ?? {}), ...(options.capabilities ?? [])]),
  ]

  const shutdown = (reason: string): Promise<void> => {
    closing ??= (async () => {
      try {
        await options.onShutdown?.(reason)
      } finally {
        kernel.peer.dispose()
      }
    })()
    return closing
  }

  const handle = async (method: string, rawParams: unknown, ctx: InboundContext): Promise<unknown> => {
    const params = jsonValue(rawParams)
    if (method === arpMethods.hello) {
      const parsed = arpHelloParams.safeParse(params)
      if (!parsed.success) throw new AppError(SystemErrorCode.invalidParams, 'ARP hello 参数无效')
      if (parsed.data.protocolVersion !== ARP_VERSION) {
        throw new AppError(
          arpErrors.protocolMismatch,
          `ARP 版本不一致：Core ${parsed.data.protocolVersion}，Runtime ${ARP_VERSION}`,
          {
            coreProtocolVersion: parsed.data.protocolVersion,
            runtimeProtocolVersion: ARP_VERSION,
          },
        )
      }
      return {
        ...arpHelloResult.parse({ protocolVersion: ARP_VERSION, ...options.info, capabilities }),
      } satisfies object
    }
    if (method === arpMethods.ping) return arpPingResult.parse({ at: new Date().toISOString() })
    if (method === arpMethods.shutdown) {
      setTimeout(() => void shutdown('requested'), 0)
      return {}
    }
    const handler = options.handlers?.[method]
    if (handler === undefined) throw new AppError(SystemErrorCode.methodNotFound, `未知 ARP 方法 ${method}`)
    return await handler(params, ctx)
  }

  const peer = new RpcPeer({
    name: 'runtime-worker',
    transport: options.transport,
    logger: options.logger,
    onRequest: handle,
    defaultTimeoutMs: 30_000,
  })
  const kernel: RuntimeKernel = { peer, shutdown }
  return kernel
}
