import { type Disposable, toDisposable } from './disposable'
import { lastResort } from './last-resort'

/** 订阅函数：传入监听器，返回取消订阅的 Disposable */
export type Event<T> = (listener: (value: T) => void) => Disposable

/**
 * 事件发射器。监听器抛错时经 `lastResort` 兜底并继续通知其余监听器
 * （foundation 没有 logger，这一处只能交给日志系统不可用时的最后通道）。
 * 通知时对监听器集合做快照：在回调中新增的监听器本次不会收到，在回调中移除的监听器本次仍会收到。
 *
 * 调用方（已经拿着 logger 的模块，比如 OmpSession、InteractionBroker）可以给一份
 * `onListenerError`：异常照旧不外抛、其余监听器照旧收到，只是改成记在有上下文的那条日志上
 * （R-08-4）。不给就仍是 `lastResort`。
 */
export interface EmitterOptions {
  readonly onListenerError?: (error: unknown) => void
}

export class Emitter<T> implements Disposable {
  private listeners: Set<(value: T) => void> | undefined = new Set()

  constructor(private readonly options: EmitterOptions = {}) {}

  readonly event: Event<T> = (listener) => {
    const set = this.listeners
    if (set === undefined) return toDisposable(() => {})
    // 每次订阅包一层新函数：同一个函数订阅两次就是两个订阅，各自取消
    const entry = (value: T): void => listener(value)
    set.add(entry)
    return toDisposable(() => {
      set.delete(entry)
    })
  }

  get hasListeners(): boolean {
    return (this.listeners?.size ?? 0) > 0
  }

  fire(value: T): void {
    const set = this.listeners
    if (set === undefined) return
    for (const listener of [...set]) {
      try {
        listener(value)
      } catch (e) {
        /* 兜底通道自己抛错也不能冲出去：fire 的调用方不该被监听器的事故连累 */
        try {
          if (this.options.onListenerError === undefined) lastResort('[Emitter] listener threw', e)
          else this.options.onListenerError(e)
        } catch {
          lastResort('[Emitter] listener error handler threw', e)
        }
      }
    }
  }

  dispose(): void {
    this.listeners?.clear()
    this.listeners = undefined
  }
}

/** 等待事件的下一次触发。signal 中止时 reject（reason 为 signal.reason） */
export function onceEvent<T>(event: Event<T>, signal?: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(signal.reason)
      return
    }
    const onAbort = (): void => {
      sub.dispose()
      reject(signal?.reason)
    }
    const sub = event((value) => {
      sub.dispose()
      signal?.removeEventListener('abort', onAbort)
      resolve(value)
    })
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}
