import type {
  Contract,
  MethodName,
  NotificationName,
  NotificationParams,
  ParamsIn,
  ResultOf,
} from '@poietica/contract-kit'
import type { Disposable } from '@poietica/foundation'

export interface CallOptions {
  readonly signal?: AbortSignal
  readonly timeoutMs?: number
}

export interface TypedRpcClient<C extends Contract> {
  call<N extends MethodName<C>>(name: N, params: ParamsIn<C, N>, opts?: CallOptions): Promise<ResultOf<C, N>>
  on<N extends NotificationName<C>>(name: N, listener: (params: NotificationParams<C, N>) => void): Disposable
}

/** 底层通道：UI 内核和 Host 内核各自实现（负责 traceId、结果校验开关、通知分发）。 */
export interface RpcChannel {
  request(method: string, params: unknown, opts: CallOptions & { timeoutMs: number }): Promise<unknown>
  subscribe(notification: string, listener: (params: unknown) => void): Disposable
}

export function createTypedClient<C extends Contract>(
  contract: C,
  channel: RpcChannel,
  opts: { validateResults: boolean },
): TypedRpcClient<C> {
  const methods = new Map(contract.methods.map((m) => [m.name, m]))
  const notifications = new Map(contract.notifications.map((n) => [n.name, n]))
  return {
    async call(name, params, callOpts) {
      const def = methods.get(name)
      if (def === undefined) throw new Error(`契约 ${contract.id} 中没有方法 ${String(name)}`) // 类型系统已保证，不会发生
      const raw = await channel.request(name, params, { ...callOpts, timeoutMs: callOpts?.timeoutMs ?? def.timeoutMs })
      return (opts.validateResults ? def.result.parse(raw) : raw) as never
    },
    on(name, listener) {
      const def = notifications.get(name)
      if (def === undefined) throw new Error(`契约 ${contract.id} 中没有通知 ${String(name)}`)
      return channel.subscribe(name, (raw) => listener((opts.validateResults ? def.params.parse(raw) : raw) as never))
    },
  }
}
