/**
 * 取消这件事只有一个原语：平台的 AbortSignal。
 *
 * 这里不再自建 token / listener 数组 / 计时器。AbortController 已经提供了
 * 全部语义：level-triggered 的 `aborted`、`{ once: true }` 的自动注销、
 * `AbortSignal.timeout(ms)` 的超时源、以及 `AbortSignal.any()` 的组合。
 * 自己再造一层，唯一的产物是两套需要同步的取消模型。
 */

export const CANCELLATION_REASONS = ['aborted', 'timeout', 'cancelled', 'superseded'] as const

/**
 * 取消原因。
 *
 * 不带 `| string` 兜底：联合类型一旦并上 string 就坍塌成 string，
 * 四个字面量在类型系统里等于不存在，收窄和穷尽检查全部失效。
 */
export type CancellationReason = (typeof CANCELLATION_REASONS)[number]

export class CancellationError extends Error {
  readonly reason: CancellationReason

  constructor(reason: CancellationReason, options?: { cause?: unknown }) {
    super(`Cancelled: ${reason}`, options)
    this.name = 'CancellationError'
    this.reason = reason
  }
}

export function isCancellationError(error: unknown): error is CancellationError {
  return error instanceof CancellationError
}

/**
 * 把 signal 的 abort 理由翻译成本域的取消原因。
 *
 * `AbortSignal.timeout` 抛的是 TimeoutError（DOMException），这是标准约定的
 * 唯一可靠判据；其余一律记作 aborted。
 */
export function cancellationReasonOf(signal: AbortSignal): CancellationReason {
  const reason: unknown = signal.reason

  if (reason instanceof CancellationError) {
    return reason.reason
  }

  if (typeof DOMException !== 'undefined' && reason instanceof DOMException) {
    return reason.name === 'TimeoutError' ? 'timeout' : 'aborted'
  }

  return 'aborted'
}

/**
 * 让一个不认识 signal 的 promise 也能被取消。
 *
 * 取消只是让**等待**提前结束；底层工作能否真正停下，取决于它自己是否接了
 * signal。调用方必须清楚这一点，所以这里不假装能杀死任务，也不提供
 * onCancel 回调 —— 想在取消时做事，catch CancellationError 即可，
 * 不需要第二条并行的通知路径。
 */
export function withCancellation<T>(signal: AbortSignal, promise: Promise<T>): Promise<T> {
  if (signal.aborted) {
    return Promise.reject(
      new CancellationError(cancellationReasonOf(signal), { cause: signal.reason }),
    )
  }

  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      reject(new CancellationError(cancellationReasonOf(signal), { cause: signal.reason }))
    }

    signal.addEventListener('abort', onAbort, { once: true })

    const detach = (): void => signal.removeEventListener('abort', onAbort)

    promise.then(
      (value) => {
        detach()
        resolve(value)
      },
      (error: unknown) => {
        detach()
        reject(error)
      },
    )
  })
}
