import { AppError, SystemErrorCode } from './errors'
import type { ServiceToken } from './service-token'

/** 内核自己提供的服务（例如 UI 内核的 navigation）使用这个 owner；任何模块都可以 get，无需 dependsOn。 */
export const KERNEL_OWNER = 'kernel'

export interface ModuleServices {
  provide<T>(token: ServiceToken<T>, impl: T): void
  get<T>(token: ServiceToken<T>): T
  /** 可选依赖：提供方模块没有加载时返回 undefined；仍要求 dependsOn 声明。 */
  tryGet<T>(token: ServiceToken<T>): T | undefined
}

export interface ServiceRegistry {
  scoped(moduleId: string, dependsOn: readonly string[]): ModuleServices
  kernelScope(): Pick<ModuleServices, 'provide'>
  /** 永久撤销本次注册表里的模块作用域，同时移除它提供的服务；已取出的对象不能被追回。 */
  revoke(moduleId: string): void
}

export function createServiceRegistry(): ServiceRegistry {
  const impls = new Map<ServiceToken<unknown>, unknown>()
  const key = (t: ServiceToken<unknown>) => `${t.ownerModule}/${t.name}`
  const provided = new Set<string>()
  const revoked = new Set<string>()
  const assertActive = (moduleId: string): void => {
    if (revoked.has(moduleId)) {
      throw new AppError(SystemErrorCode.serviceAccessDenied, `模块 ${moduleId} 的服务作用域已撤销`)
    }
  }

  const provideImpl = (owner: string, token: ServiceToken<unknown>, impl: unknown): void => {
    assertActive(owner)
    if (token.ownerModule !== owner) {
      throw new AppError(
        SystemErrorCode.serviceAccessDenied,
        `${owner} 不能提供属于 ${token.ownerModule} 的服务 ${token.name}`,
      )
    }
    if (provided.has(key(token))) throw new AppError(SystemErrorCode.conflict, `服务 ${key(token)} 重复提供`)
    provided.add(key(token))
    impls.set(token, impl)
  }

  return {
    scoped(moduleId, dependsOn) {
      const allowed = new Set([moduleId, KERNEL_OWNER, ...dependsOn])
      const check = (token: ServiceToken<unknown>): void => {
        assertActive(moduleId)
        if (!allowed.has(token.ownerModule)) {
          throw new AppError(
            SystemErrorCode.serviceAccessDenied,
            `${moduleId} 使用 ${key(token)} 前必须在 dependsOn 中声明 '${token.ownerModule}'`,
          )
        }
      }
      return {
        provide: (token, impl) => provideImpl(moduleId, token as ServiceToken<unknown>, impl),
        get: <T>(token: ServiceToken<T>): T => {
          check(token as ServiceToken<unknown>)
          if (!impls.has(token as ServiceToken<unknown>)) {
            throw new AppError(
              SystemErrorCode.notFound,
              `服务 ${key(token as ServiceToken<unknown>)} 尚未提供（提供方没有加载，或在 setup 中漏了 provide）`,
            )
          }
          return impls.get(token as ServiceToken<unknown>) as T
        },
        tryGet: <T>(token: ServiceToken<T>): T | undefined => {
          check(token as ServiceToken<unknown>)
          return impls.get(token as ServiceToken<unknown>) as T | undefined
        },
      }
    },
    revoke(moduleId) {
      revoked.add(moduleId)
      for (const token of impls.keys()) {
        if (token.ownerModule !== moduleId) continue
        impls.delete(token)
        provided.delete(key(token))
      }
    },
    kernelScope: () => ({ provide: (token, impl) => provideImpl(KERNEL_OWNER, token as ServiceToken<unknown>, impl) }),
  }
}
