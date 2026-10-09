import type { Logger } from '@poietica/foundation'

/**
 * 事件泵的异常账本（R-02 §2.4）：同一轮同一事件类型只 warn 一次，其余计数，轮终汇总一条。
 *
 * 为什么不在每次异常都写日志：一条事件处理失败往往不是孤例（同一条 omp 事件会在流式期间
 * 反复到达），逐条 warn 会把日志刷满，真正的第一条反而被埋掉。按「事件类型」去重是因为
 * 同一类型的失败原因通常相同，跨类型（例如一边旁路一边收尾）则各留一条。
 */
export class EventFaults {
  readonly #reported = new Set<string>()
  #suppressed = 0

  constructor(
    private readonly logger: Logger,
    private readonly turnOrdinal: () => number,
  ) {}

  report(eventType: string, error: unknown, detail: Record<string, unknown> = {}): void {
    if (this.#reported.has(eventType)) {
      this.#suppressed += 1
      return
    }
    this.#reported.add(eventType)
    this.logger.warn('omp event projection failed', {
      eventType,
      turn: this.turnOrdinal(),
      ...detail,
      error: describeError(error),
    })
  }

  /** 轮终调用：有被压掉的同类异常就汇总一条，然后清零 */
  settle(): void {
    if (this.#suppressed > 0) {
      this.logger.warn('omp event projection failures suppressed', {
        turn: this.turnOrdinal(),
        count: this.#suppressed,
      })
    }
    this.#reported.clear()
    this.#suppressed = 0
  }
}

/** 异常 → 日志里那一格。非 Error 且连字符串化都抛（无原型对象、抛异常的 toString）也有兜底 */
export function describeError(error: unknown): string {
  if (error instanceof Error) return error.stack ?? error.message
  try {
    return String(error)
  } catch {
    return 'unprintable error'
  }
}
