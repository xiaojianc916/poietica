import { type Clock, systemClock } from './clock'

/** 把 resolve/reject 暴露出来的 Promise；settled 之后再次 resolve/reject 没有效果。 */
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

/**
 * 超时后以 onTimeout() 的返回值 reject。不会取消原 Promise（需要取消请配合 AbortSignal）。
 *
 * 计时走**注入的 Clock**：关停预算那类路径的截止时间由 clock.now() 算，等真实 setTimeout 的话
 * 测试注入的假时钟推不动它（core-kernel 的关停路径就是这样验收的）。
 */
export function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  onTimeout: () => Error,
  clock: Clock = systemClock,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = clock.setTimeout(() => reject(onTimeout()), ms)
    promise.then(
      (value) => {
        timer.dispose()
        resolve(value)
      },
      (error: unknown) => {
        timer.dispose()
        reject(error)
      },
    )
  })
}
