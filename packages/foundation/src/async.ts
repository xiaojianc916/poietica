import { InvariantError } from './assert'

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
/**
 * 有界并发地映射一遍：最多 `limit` 个任务同时进行，结果按输入顺序交回。
 *
 * 只在任务彼此独立时用；共享事务顺序、资源独占或需要取消语义的循环不要换成本函数 ——
 * 顺序 `for await` 是那些场合的正确写法，不是性能缺陷。
 */
export async function mapLimited<T, R>(
  items: readonly T[],
  limit: number,
  map: (item: T, index: number) => Promise<R> | R,
): Promise<R[]> {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new InvariantError(`并发上限必须是正整数：${String(limit)}`)
  }
  const results = new Array<R>(items.length)
  const iterator = items.values()
  let index = 0
  let failed = false
  /* 取下一项是同步的：JavaScript 单线程里，各 worker 不会同时拿到同一个下标。 */
  const take = (): { readonly item: T; readonly index: number } | null => {
    if (failed) return null
    const next = iterator.next()
    if (next.done) return null
    const at = index
    index += 1
    return { item: next.value, index: at }
  }
  const worker = async (): Promise<void> => {
    for (let slot = take(); slot !== null; slot = take()) {
      try {
        results[slot.index] = await map(slot.item, slot.index)
      } catch (error) {
        /* 一个任务失败后不再领新任务；已经在飞的那几个自然结束，I/O 没有取消语义就不假装有。 */
        failed = true
        throw error
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}
