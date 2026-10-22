import type { ContextUsage, SessionTokenUsage } from '@poietica/engine'

/*
 * omp 的上下文读数、构成与会话用量 → 引擎端口的 ContextUsage。**纯映射**，不认识 omp 类型：
 * 上游那三格按结构收窄，单测因此不用起会话。
 *
 * 两处形状差异是这次修复的要害（真机故障「输入框没有用量显示」）： *
 * omp 的 getContextUsage() 报的是 { tokens, contextWindow, percent }（pi-tui 的
 * status-line/types），而旧代码按 { usedTokens, windowTokens } 去读 —— 两个字段名都不存在， * 于是恒为 undefined、恒被判成「会话还没报过」，圆环永远不画。percent 不取：它是
 * omp 自己按窗口算的整数百分比，本仓的读数一律由 used/size 现算（面板与圆环同一处算法，
 * 见 context-gauge 的 gaugeLayout），取两份会在四舍五入上打架。
 *
 * 构成明细取 omp 自己的 computeContextBreakdown（/context 面板那一份），不自己按
 * getContextBreakdown 那五格折 —— omp 把「技能」从系统提示词里减出去，自己折就会与它在屏幕上显示的那份对不上。
 *
 * 会话用量取 omp 的 sessionManager.getUsageStatistics()（/usage 与 ACP usage_update 的同一份），
 * 不取 getSessionStats().tokens：后者只数**当前上下文窗口**里的消息，压缩一次就掉回去，不是「这个会话花了多少」。
 */

/** omp 的 ContextUsage（按结构收窄，不绑 omp 深层类型） */
export interface OmpContextUsageLike {
  readonly tokens?: number | undefined
  readonly contextWindow?: number | undefined
}

/** omp 的 ContextBreakdown（同上，只取本仓真读的那几格） */
export interface OmpContextBreakdownLike {
  readonly contextWindow?: number | undefined
  readonly usedTokens?: number | undefined
  readonly categories?:
    readonly { readonly id?: string | undefined; readonly tokens?: number | undefined }[] | undefined
}

/** omp 的 UsageStatistics（session-entries.ts；同上，只取 token 那几格，费用与编排口径不转运） */
export interface OmpUsageStatisticsLike {
  readonly input?: number | undefined
  readonly output?: number | undefined
  readonly cacheRead?: number | undefined
  readonly cacheWrite?: number | undefined
  readonly totalTokens?: number | undefined
}

function finite(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function count(value: number | undefined): number | undefined {
  const n = finite(value)
  return n === undefined ? undefined : Math.max(0, Math.trunc(n))
}

/** 构成里某一类的读数；认不得的 id 当 0 */
function tokensOf(breakdown: OmpContextBreakdownLike, id: string): number {
  return finite(breakdown.categories?.find((category) => category.id === id)?.tokens) ?? 0
}

/**
 * 会话用量。四格计数缺一格就整体交 null —— 半份数字算出来的命中率是错的，不如不画。
 * `total` 照 omp 自己的 totalTokens；它缺了才按 pi-ai 的恒等式现加（四格之和）。
 */
export function toSessionTokenUsage(stats: OmpUsageStatisticsLike | undefined): SessionTokenUsage | null {
  if (stats === undefined) return null
  const input = count(stats.input)
  const output = count(stats.output)
  const cacheRead = count(stats.cacheRead)
  const cacheWrite = count(stats.cacheWrite)
  if (input === undefined || output === undefined || cacheRead === undefined || cacheWrite === undefined) return null
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    total: count(stats.totalTokens) ?? input + output + cacheRead + cacheWrite,
  }
}

/**
 * 读数、构成与会话用量。
 *
 * **没有分母就整体交 null**：`ContextGauge` 按 `size <= 0` 不画（正本同此），所以
 * 「窗口未知」在这一层收敛成一种写法，屏幕那侧不必再判一次。报 0 会画出一颗永远空的圆环，
 * 那比不画更像故障。
 *
 * 两条来源都认，且顺序固定：先 `getContextUsage`（状态行那一份），缺了才退构成里那两格。
 * 两条都缺就是 null —— 不编数。
 */
export function toContextUsage(
  usage: OmpContextUsageLike | undefined,
  breakdown: OmpContextBreakdownLike | undefined,
  stats?: OmpUsageStatisticsLike | undefined,
): ContextUsage | null {
  const used = finite(usage?.tokens) ?? finite(breakdown?.usedTokens)
  const window = finite(usage?.contextWindow) ?? finite(breakdown?.contextWindow)

  if (used === undefined || window === undefined || window <= 0) {
    return null
  }

  return {
    usedTokens: Math.max(0, Math.trunc(used)),
    windowTokens: Math.trunc(window),
    breakdown:
      breakdown === undefined
        ? null
        : {
            systemPrompt: tokensOf(breakdown, 'systemPrompt'),
            systemContext: tokensOf(breakdown, 'systemContext'),
            systemTools: tokensOf(breakdown, 'systemTools'),
            skills: tokensOf(breakdown, 'skills'),
            messages: tokensOf(breakdown, 'messages'),
          },
    session: toSessionTokenUsage(stats),
  }
}
