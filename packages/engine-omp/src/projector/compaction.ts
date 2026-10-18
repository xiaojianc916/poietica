/*
 * 压缩那一格的载荷：历史与增量两条路共用这一份口径（各写一份就会一边带 token 数、一边不带）。
 *
 * 状态只有四档：running（增量那条路开门）、completed、cancelled（人中止 / 扩展否决）、failed（omp 报了错）。
 * 「跳过」（没有可压的、没有模型）不是一次压缩：那一格直接撤掉，不留一行「完成」骗人。
 */

/**
 * omp 知识 #20：显示经过里，被后一次压缩取代的那份摘要换成了这句占位（session-context.ts 的
 * SUPERSEDED_COMPACTION_SUMMARY，没有导出）。它不是摘要，不能当摘要摆给人看。
 */
export const SUPERSEDED_SUMMARY = '[Superseded compaction summary elided after a newer compaction]'

/** 一条压缩摘要（omp 的 CompactionSummaryMessage）里要读的那几格；history 的 OmpMessage 按结构兼容 */
export interface CompactionMessage {
  readonly role?: string
  readonly summary?: string
  readonly shortSummary?: string
  readonly tokensBefore?: number
  readonly tokensAfter?: number
  readonly method?: string
  readonly warning?: string
}

/** 落了盘的一次压缩（role: compactionSummary）：一定已经做完，所以恒为 completed */
export function compactionPayloadOf(message: CompactionMessage): Record<string, unknown> {
  const payload: Record<string, unknown> = { state: 'completed' }
  const summary = message.summary
  if (summary === SUPERSEDED_SUMMARY) {
    payload.superseded = true
  } else {
    if (typeof summary === 'string' && summary !== '') payload.summary = summary
    if (typeof message.shortSummary === 'string' && message.shortSummary !== '') {
      payload.shortSummary = message.shortSummary
    }
  }
  if (isCount(message.tokensBefore)) payload.tokensBefore = message.tokensBefore
  if (isCount(message.tokensAfter)) payload.tokensAfter = message.tokensAfter
  if (typeof message.method === 'string' && message.method !== '') payload.method = message.method
  if (typeof message.warning === 'string' && message.warning !== '') payload.warning = message.warning
  return payload
}

/** omp 的 auto_compaction_end（只取要读的那几格） */
export interface CompactionEndEvent {
  readonly aborted?: unknown
  readonly skipped?: unknown
  readonly errorMessage?: unknown
  readonly result?: unknown
}

/**
 * 关门那一份载荷；null = 这次其实没压（skipped），那一格该撤掉。
 *
 * `persisted` 是 omp 刚落盘的那条压缩摘要（omp 知识 #20）：有结果时 omp 先写条目、再发 end，所以此刻读得到，
 * 而 tokensAfter 只在条目上（事件里的 CompactionResult 不带它）。读不到就退回事件里的 result。
 */
export function compactionEndPayload(
  event: CompactionEndEvent,
  persisted: CompactionMessage | undefined,
): Record<string, unknown> | null {
  const error = typeof event.errorMessage === 'string' && event.errorMessage !== '' ? event.errorMessage : undefined
  if (event.aborted === true) return { state: 'cancelled', ...(error === undefined ? {} : { error }) }
  const result =
    typeof event.result === 'object' && event.result !== null ? (event.result as CompactionMessage) : undefined
  if (result !== undefined) return compactionPayloadOf(persisted ?? result)
  if (error !== undefined) return { state: 'failed', error }
  if (event.skipped === true) return null
  /* shake 这类就地改写：没有 result，也不是失败 —— 做完了 */
  return { state: 'completed' }
}

export function latestCompactionOf<M extends CompactionMessage>(messages: readonly M[]): M | undefined {
  return messages.findLast((message) => message.role === 'compactionSummary')
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}
