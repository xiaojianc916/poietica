import type {
  AnyMethod,
  AnyNotification,
  Contract,
  MethodName,
  NotificationName,
  NotificationParams,
  ParamsOut,
  ResultOf,
} from '@poietica/contract-kit'
import { AppError, type Disposable, SystemErrorCode } from '@poietica/foundation'
import type { InboundContext, Router } from '@poietica/rpc'

export interface HostRpcBinding<C extends Contract> {
  handle<N extends MethodName<C>>(
    name: N,
    handler: (params: ParamsOut<C, N>, ctx: InboundContext) => Promise<ResultOf<C, N>> | ResultOf<C, N>,
  ): Disposable
  emit<N extends NotificationName<C>>(name: N, params: NotificationParams<C, N>): void
}

export function createHostRpcBinding<C extends Contract>(
  contract: C | undefined,
  deps: { moduleId: string; router: Router; broadcast: (method: string, params: unknown) => void; strict: boolean },
): HostRpcBinding<C> {
  const methods = new Map<string, AnyMethod>((contract?.methods ?? []).map((m) => [m.name, m]))
  const notifications = new Map<string, AnyNotification>((contract?.notifications ?? []).map((n) => [n.name, n]))
  return {
    handle(name, handler) {
      const def = methods.get(name)
      if (def === undefined || def.owner !== 'host') {
        throw new AppError(
          SystemErrorCode.unhandledMethod,
          `${deps.moduleId} 不能实现 ${String(name)}：它不是本模块契约中 owner='host' 的方法`,
        )
      }
      return deps.router.register(def, async (params, ctx) => {
        const result = await handler(params as never, ctx)
        if (deps.strict) def.result.parse(result)
        return result
      })
    },
    emit(name, params) {
      const def = notifications.get(name)
      if (def === undefined || def.owner !== 'host') {
        throw new AppError(
          SystemErrorCode.unhandledMethod,
          `${deps.moduleId} 不能发出 ${String(name)}：它不是本模块契约中 owner='host' 的通知`,
        )
      }
      if (deps.strict) def.params.parse(params)
      deps.broadcast(def.name, params)
    },
  }
}
