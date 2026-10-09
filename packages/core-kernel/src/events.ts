import { AppError, type Disposable, type Logger, SystemErrorCode } from '@poietica/foundation'
import type { CoreEvent } from './events-def'

export { type CoreEvent, defineCoreEvent } from './events-def'

export interface CoreEventBus {
  /** 只有 ownerModule === 本模块 id 才能发出 */
  emit<T>(event: CoreEvent<T>, payload: T): void
  /** 订阅方必须在 dependsOn 中声明 ownerModule */
  on<T>(event: CoreEvent<T>, handler: (payload: T) => void | Promise<void>): Disposable
}

export interface EventHub {
  scoped(moduleId: string, dependsOn: readonly string[], logger: Logger): CoreEventBus
}

interface Entry {
  readonly moduleId: string
  readonly fn: (p: unknown) => void | Promise<void>
  readonly logger: Logger
}

/** 同步分发、按订阅顺序；发出方不等待异步处理完成；订阅方的异常不影响发出方 */
export function createEventHub(): EventHub {
  const handlers = new Map<CoreEvent<unknown>, Set<Entry>>()
  return {
    scoped(moduleId, dependsOn, logger) {
      const allowed = new Set([moduleId, ...dependsOn])
      return {
        emit(event, payload) {
          if (event.ownerModule !== moduleId) {
            throw new AppError(
              SystemErrorCode.serviceAccessDenied,
              `${moduleId} 不能发出属于 ${event.ownerModule} 的事件 ${event.name}`,
            )
          }
          for (const h of [...(handlers.get(event as CoreEvent<unknown>) ?? [])]) {
            try {
              const r = h.fn(payload)
              if (r instanceof Promise) {
                r.catch((e: unknown) =>
                  h.logger.error('event handler rejected', { event: event.name, error: String(e) }),
                )
              }
            } catch (e) {
              h.logger.error('event handler threw', { event: event.name, error: String(e) })
            }
          }
        },
        on(event, fn) {
          if (!allowed.has(event.ownerModule)) {
            throw new AppError(
              SystemErrorCode.serviceAccessDenied,
              `${moduleId} 订阅 ${event.ownerModule}.${event.name} 前必须在 dependsOn 中声明 '${event.ownerModule}'`,
            )
          }
          const set = handlers.get(event as CoreEvent<unknown>) ?? new Set<Entry>()
          handlers.set(event as CoreEvent<unknown>, set)
          const entry: Entry = { moduleId, fn: fn as (p: unknown) => void | Promise<void>, logger }
          set.add(entry)
          return {
            dispose: () => {
              set.delete(entry)
            },
          }
        },
      }
    },
  }
}
