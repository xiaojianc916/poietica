interface WindowErrorLike {
  readonly message: string
  readonly error: unknown
}

/**
 * 浏览器引擎把 ResizeObserver 的投递推迟到下一帧时发出的那两句话。
 *
 * 精确白名单：不因为消息里含 ResizeObserver 就放过任意错误。
 */
const BENIGN_MESSAGES = new Set([
  'ResizeObserver loop completed with undelivered notifications.',
  'ResizeObserver loop limit exceeded',
])

export function isBenignWindowError({ message, error }: WindowErrorLike): boolean {
  const candidates = [message, error instanceof Error ? error.message : error]

  return candidates.some(
    (candidate) => typeof candidate === 'string' && BENIGN_MESSAGES.has(candidate.trim()),
  )
}
