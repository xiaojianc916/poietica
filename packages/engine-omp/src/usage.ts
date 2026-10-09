import type { UsageSample } from '@poietica/engine'

/**
 * 一条 assistant 消息的用量（12 页 §11.3，迁移自 legacy 的用量读取）。
 * 只处理 role 为 assistant、带 usage 的消息；全为 0 时返回 null，不发事件。
 */
export function usageOf(
  message: { readonly role?: string; readonly usage?: unknown; readonly provider?: string; readonly model?: string },
  at: number,
): UsageSample | null {
  if (message.role !== 'assistant') return null
  const raw = message.usage
  if (typeof raw !== 'object' || raw === null) return null
  const usage = raw as {
    readonly input?: unknown
    readonly inputTokens?: unknown
    readonly output?: unknown
    readonly outputTokens?: unknown
    readonly cacheRead?: unknown
    readonly cacheWrite?: unknown
    readonly cost?: { readonly total?: unknown } | number
  }
  const int = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0)
  const input = int(usage.input ?? usage.inputTokens)
  const output = int(usage.output ?? usage.outputTokens)
  const cacheRead = int(usage.cacheRead)
  const cacheWrite = int(usage.cacheWrite)
  const cost =
    typeof usage.cost === 'number' ? usage.cost : typeof usage.cost?.total === 'number' ? usage.cost.total : 0
  if (input === 0 && output === 0 && cacheRead === 0 && cacheWrite === 0 && cost === 0) return null
  return {
    provider: message.provider ?? '',
    model: message.model ?? '',
    input,
    output,
    cacheRead,
    cacheWrite,
    cost,
    at,
  }
}
