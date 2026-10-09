import type {
  AnyMethod,
  AnyNotification,
  Contract,
  MethodName,
  NotificationName,
  NotificationParams,
  ParamsIn,
  ParamsOut,
  ResultOf,
} from '@poietica/contract-kit'
import { AppError, createId, type Disposable, SystemErrorCode } from '@poietica/foundation'
import type { InboundContext, Router, RpcPeer } from '@poietica/rpc'

export interface CoreRpcBinding<C extends Contract> {
  /** 注册本模块契约中 owner='core' 的方法实现。handler 收到的参数已经过 zod 校验。 */
  handle<N extends MethodName<C>>(
    name: N,
    handler: (params: ParamsOut<C, N>, ctx: InboundContext) => Promise<ResultOf<C, N>> | ResultOf<C, N>,
  ): Disposable
  /** 发出本模块契约中 owner='core' 的通知。 */
  emit<N extends NotificationName<C>>(name: N, params: NotificationParams<C, N>): void
}

/** Core 调用 Host 的方法（只允许 owner='host' 的方法），例如 extensions 调 shell.trashItem。 */
export interface HostCaller {
  call<C extends Contract, N extends MethodName<C>>(
    contract: C,
    name: N,
    params: ParamsIn<C, N>,
    opts?: { signal?: AbortSignal; timeoutMs?: number },
  ): Promise<ResultOf<C, N>>
}

export interface RpcBindingDeps {
  readonly moduleId: string
  readonly router: Router
  /** 惰性获取：内核在 start() 第 0 步创建 peer */
  readonly peer: () => RpcPeer
  /** 开发版 true：校验本端发出的结果与通知 */
  readonly strict: boolean
}

export function createCoreRpcBinding<C extends Contract>(
  contract: C | undefined,
  deps: RpcBindingDeps,
): CoreRpcBinding<C> {
  const methodDefs = new Map<string, AnyMethod>((contract?.methods ?? []).map((m) => [m.name, m]))
  const notificationDefs = new Map<string, AnyNotification>((contract?.notifications ?? []).map((n) => [n.name, n]))
  return {
    handle(name, handler) {
      const def = methodDefs.get(name)
      if (def === undefined || def.owner !== 'core') {
        throw new AppError(
          SystemErrorCode.unhandledMethod,
          `${deps.moduleId} 不能实现 ${String(name)}：它不是本模块契约中 owner='core' 的方法`,
        )
      }
      return deps.router.register(def, async (params, ctx) => {
        const result = await handler(params as never, ctx)
        if (deps.strict) {
          const checked = def.result.safeParse(result)
          if (!checked.success) {
            throw new AppError(SystemErrorCode.internal, `${def.name} 的返回值不符合契约：${checked.error.message}`)
          }
        }
        return result
      })
    },
    emit(name, params) {
      const def = notificationDefs.get(name)
      if (def === undefined || def.owner !== 'core') {
        throw new AppError(
          SystemErrorCode.unhandledMethod,
          `${deps.moduleId} 不能发出 ${String(name)}：它不是本模块契约中 owner='core' 的通知`,
        )
      }
      if (deps.strict) {
        const checked = def.params.safeParse(params)
        if (!checked.success) {
          throw new AppError(SystemErrorCode.internal, `${def.name} 的参数不符合契约：${checked.error.message}`)
        }
      }
      deps.peer().notify(def.name, params)
    },
  }
}

export function createHostCaller(deps: Pick<RpcBindingDeps, 'peer'>): HostCaller {
  return {
    async call(contract, name, params, opts) {
      const def = contract.methods.find((m) => m.name === name)
      if (def === undefined || def.owner !== 'host') {
        throw new AppError(SystemErrorCode.methodNotFound, `Core 只能调用 owner='host' 的方法，${String(name)} 不是`)
      }
      const raw = await deps.peer().request(def.name, def.params.parse(params), {
        timeoutMs: opts?.timeoutMs ?? def.timeoutMs,
        ...(opts?.signal === undefined ? {} : { signal: opts.signal }),
        meta: { traceId: createId(), origin: 'core' },
      })
      return def.result.parse(raw) as never
    },
  }
}
