import type { RetryNotice, RetryNoticeState } from '@poietica/transcript'

/*
 * 自动重试那一格的文字（omp 的 auto_retry_start / auto_retry_end）。报错原文照抄给展开那一面看，
 * 只有 omp 自己拼出来的那两句（取消、等待超过上限）认得，换成中文；判据是 omp 18.10.3 turn-recovery 的原句。
 */

/** 人按了停止：omp 收口时 finalError 写的就是这一句 */
const CANCELLED = 'Retry cancelled'

/** 服务商要求的等待超过 retry.maxDelayMs、又没有可换的凭据或模型时，omp 不睡下去，直接收口 */
const OVER_WAIT = /^Provider requested (\d+)ms wait, exceeds retry\.maxDelayMs \((\d+)ms\)\. Original error: ([\s\S]*)$/

function durationOf(ms: number): string {
  const seconds = Math.ceil(ms / 1000)
  if (seconds >= 3600) return `${String(Math.round(seconds / 360) / 10)} 小时`
  if (seconds >= 60) return `${String(Math.round(seconds / 6) / 10)} 分钟`
  return `${String(seconds)} 秒`
}

/** 一条请求失败的原文；omp 拼出来的「等待超过上限」说中文，后面照抄服务商的原始报错 */
export function retryErrorText(raw: string): string {
  const text = raw.trim()
  const over = OVER_WAIT.exec(text)
  if (over === null) return text
  const asked = durationOf(Number(over[1]))
  const limit = durationOf(Number(over[2]))
  return `服务商要求等待 ${asked}，超过重试间隔上限（${limit}），不再重试。原始报错：${over[3] ?? ''}`
}

/** 收口时这一格落成哪一态：成功、被人停下、其余都算失败 */
export function retryEndState(success: boolean, finalError: string): RetryNoticeState {
  if (success) return 'recovered'
  return finalError.trim() === CANCELLED ? 'cancelled' : 'failed'
}

/** notice 帧的 message：给只读 message 的消费方（日志、旧界面）一句能看懂的话；界面按 detail 自己画 */
export function retryMessageOf(notice: RetryNotice): string {
  switch (notice.state) {
    case 'running':
      return `正在重试 ${String(notice.attempt)}/${String(notice.maxAttempts)}`
    case 'recovered':
      return '重试成功'
    case 'cancelled':
      return '已停止重试'
    case 'failed': {
      const last = notice.errors.at(-1)
      const head = notice.attempt > 0 ? `重试 ${String(notice.attempt)} 次仍失败` : '请求失败'
      return last === undefined ? head : `${head}：${last}`
    }
  }
}

/** omp 的 auto_retry_start 载荷 → 投影器要的三格（字段缺了按 0 / 空串，不编） */
export function retryStartOf(event: Record<string, unknown>): {
  readonly attempt: number
  readonly maxAttempts: number
  readonly error: string
} {
  return {
    attempt: countOf(event.attempt),
    maxAttempts: countOf(event.maxAttempts),
    error: typeof event.errorMessage === 'string' ? event.errorMessage : '',
  }
}

/** omp 的 auto_retry_end 载荷 → 投影器要的三格 */
export function retryEndOf(event: Record<string, unknown>): {
  readonly success: boolean
  readonly attempt: number
  readonly finalError: string
} {
  return {
    success: event.success === true,
    attempt: countOf(event.attempt),
    finalError: typeof event.finalError === 'string' ? event.finalError : '',
  }
}

function countOf(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0
}
