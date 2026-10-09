import { EngineErrorCode } from '@poietica/engine'
import { AppError, isAppError, SystemErrorCode } from '@poietica/foundation'

/**
 * 唯一的错误映射点（12 页 §0.3 / §11.2）：引擎边界把任意异常换成 AppError。
 * 判别顺序是固定的：先看 AppError，再看类名，再看 message，最后看状态码字段。
 */
export function toEngineError(error: unknown): AppError {
  if (isAppError(error)) return error
  const candidate = error as {
    name?: string
    message?: string
    provider?: string
    status?: unknown
    statusCode?: unknown
  }
  const message = typeof candidate?.message === 'string' ? candidate.message : String(error)
  if (candidate?.name === 'AgentBusyError') return new AppError(EngineErrorCode.busy, message)
  if (/no api key|api key.*not (set|configured)|not configured|missing credentials|尚未配置/i.test(message)) {
    const provider = typeof candidate.provider === 'string' ? candidate.provider : undefined
    return new AppError(
      EngineErrorCode.providerNotConfigured,
      message,
      provider === undefined ? undefined : { provider },
    )
  }
  if (/model not found|unknown model|no such model|找不到.*模型/i.test(message)) {
    return new AppError(EngineErrorCode.modelNotFound, message)
  }
  const status =
    typeof candidate.statusCode === 'number'
      ? candidate.statusCode
      : typeof candidate.status === 'number'
        ? candidate.status
        : undefined
  if (
    status !== undefined ||
    /rate limit|timed? ?out|timeout|ECONNRESET|socket hang up|overloaded|429|5\d\d/i.test(message)
  ) {
    return new AppError(EngineErrorCode.upstream, message, status === undefined ? undefined : { status })
  }
  return new AppError(SystemErrorCode.internal, message)
}

export interface TurnOutcome {
  readonly outcome: 'completed' | 'cancelled' | 'failed'
  readonly message: string | null
}

/**
 * 一轮的结局（迁移自 legacy outcome.ts）：stopReason 为 aborted → cancelled；error → failed；
 * 其它 → completed。“静默中止不算失败”的判断要保留。
 */
export function outcomeOf(last: { stopReason?: string; errorMessage?: string } | undefined): TurnOutcome {
  const reason = last?.stopReason
  if (reason === 'aborted') return { outcome: 'cancelled', message: null }
  if (reason === 'error') return { outcome: 'failed', message: last?.errorMessage ?? '模型服务返回错误' }
  return { outcome: 'completed', message: null }
}
