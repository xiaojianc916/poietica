import { z } from 'zod'

/*
 * 压缩标记的载荷词表。它是跨进程协议的一部分（引擎写 → 协议快照 → UI 读），但外面那层
 * `TranscriptMarker.payload` 只是 `unknown`：marker 是通用通道，形状由各 marker 自己认。
 * 这里就是 `marker === 'compaction'` 的那一份，生产者和消费者都从这里取，不再各读各的字符串。
 */

export const COMPACTION_MARKER = 'compaction'

/** 一次压缩此刻处于哪一档；`running` 是认不出时的兜底（报完成会把没成的压缩说成成了）。 */
export const compactionStateSchema = z.enum(['running', 'completed', 'cancelled', 'failed'])
export type CompactionState = z.infer<typeof compactionStateSchema>

/** omp `auto_compaction_start` 的 reason；`manual` 是本仓执行 `/compact` 时补的。 */
export const compactionReasonSchema = z.enum(['manual', 'threshold', 'overflow', 'idle', 'incomplete'])
export type CompactionReason = z.infer<typeof compactionReasonSchema>

/** omp 的压缩方式；`handoff` 表示摘要是一份交接文档。 */
export const compactionActionSchema = z.enum(['context-full', 'remote', 'handoff', 'shake', 'snapcompact'])
export type CompactionAction = z.infer<typeof compactionActionSchema>

export const compactionMarkerPayloadSchema = z.object({
  state: compactionStateSchema.catch('running'),
  reason: compactionReasonSchema.optional().catch(undefined),
  action: compactionActionSchema.optional().catch(undefined),
  /** 落盘的压缩摘要带它；与 action 同值但来源不同（历史文件 vs 实时事件）。 */
  method: z.string().optional().catch(undefined),
  summary: z.string().optional().catch(undefined),
  shortSummary: z.string().optional().catch(undefined),
  tokensBefore: z.number().nonnegative().optional().catch(undefined),
  tokensAfter: z.number().nonnegative().optional().catch(undefined),
  error: z.string().optional().catch(undefined),
  warning: z.string().optional().catch(undefined),
  superseded: z.literal(true).optional().catch(undefined),
})

export type CompactionMarkerPayload = z.infer<typeof compactionMarkerPayloadSchema>

/**
 * 读一份压缩标记的载荷。认不出的整体（旧会话、别的 marker 误入）按「正在跑」返回，
 * 但单个字段认不出只丢那一格——升级 omp 多出来/改名的字段不会让整条压缩记录消失。
 */
export function compactionMarkerPayload(value: unknown): CompactionMarkerPayload {
  const parsed = compactionMarkerPayloadSchema.safeParse(value)
  return parsed.success ? parsed.data : { state: 'running' }
}
