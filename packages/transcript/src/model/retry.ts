/*
 * 自动重试那一格（omp 的一次 retry saga）。线上仍是一个 notice 帧：source 是 RETRY_NOTICE_SOURCE，进展放在 detail 里。
 * 一次重试过程只占一格，每次进展按同一个 frameId 原地改写：「正在重试 1/5」→「2/5」→ … → 收口。
 * detail 在契约上是 unknown（不动协议）：引擎按 RetryNotice 写，界面经 retryNoticeOf 读，两端只认这一处的形状。
 */
export const RETRY_NOTICE_SOURCE = 'auto_retry'

/** running：在等 / 在重试；recovered：某一次成功了；failed：次数用完或不再重试；cancelled：人停下了 */
export type RetryNoticeState = 'running' | 'recovered' | 'failed' | 'cancelled'

export interface RetryNotice {
  readonly state: RetryNoticeState
  /** 第几次重试（从 1 起）；收口时是最后跑到的那一次 */
  readonly attempt: number
  readonly maxAttempts: number
  /** 每次请求失败的原文，按先后：第一条是原请求的报错 */
  readonly errors: readonly string[]
}

const STATES: ReadonlySet<string> = new Set<RetryNoticeState>(['running', 'recovered', 'failed', 'cancelled'])

const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0

/** notice 帧里的重试进展；不是重试那一格、或 detail 形状不对都是 null，调用方照普通提示画 */
export function retryNoticeOf(frame: { readonly source?: string; readonly detail?: unknown }): RetryNotice | null {
  if (frame.source !== RETRY_NOTICE_SOURCE || typeof frame.detail !== 'object' || frame.detail === null) return null
  const retry = (frame.detail as { readonly retry?: unknown }).retry
  if (typeof retry !== 'object' || retry === null) return null
  const { attempt, errors, maxAttempts, state } = retry as Record<string, unknown>
  if (typeof state !== 'string' || !STATES.has(state) || !isCount(attempt) || !isCount(maxAttempts)) return null
  if (!Array.isArray(errors) || !errors.every((error) => typeof error === 'string')) return null
  return { state: state as RetryNoticeState, attempt, maxAttempts, errors }
}
