import { AppError, SystemErrorCode } from './errors'

/** 把 resolve/reject 暴露出来的 Promise。settled 之后再次 resolve/reject 没有效果 */
export class Deferred<T> {
  readonly promise: Promise<T>
  private resolveFn!: (value: T) => void
  private rejectFn!: (reason: unknown) => void
  private state: 'pending' | 'resolved' | 'rejected' = 'pending'

  constructor() {
    this.promise = new Promise<T>((resolve, reject) => {
      this.resolveFn = resolve
      this.rejectFn = reject
    })
  }

  get settled(): boolean {
    return this.state !== 'pending'
  }

  resolve(value: T): void {
    if (this.state !== 'pending') return
    this.state = 'resolved'
    this.resolveFn(value)
  }

  reject(reason: unknown): void {
    if (this.state !== 'pending') return
    this.state = 'rejected'
    this.rejectFn(reason)
  }
}

/** 等待 ms 毫秒；signal 中止时以 kernel.cancelled reject */
export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(cancelledError())
      return
    }
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(cancelledError())
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** 超时后以 onTimeout() 的返回值 reject。不会取消原 Promise（需要取消请配合 AbortSignal） */
export function withTimeout<T>(promise: Promise<T>, ms: number, onTimeout: () => Error): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(onTimeout()), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

/** 让一个不支持取消的 Promise 可以被 signal 提前 reject（原操作仍在后台继续） */
export function abortable<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return promise
  if (signal.aborted) return Promise.reject(cancelledError())
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(cancelledError())
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      },
    )
  })
}

export function cancelledError(message = '操作已取消'): AppError {
  return new AppError(SystemErrorCode.cancelled, message)
}
