import type { TypedRpcClient } from '@poietica/rpc'
import type { UiFeatureContext } from '@poietica/ui-kernel'
import type { DayKey, MessageCountDay, ModelDay, TokenDay } from '../contract'
import { usageContract } from '../contract'

/*
 * 窗口的算式只有一份：**最近 span 天，含今天**（legacy 的 `token_days_through` 同此 ——
 * offset = span - 1，earliest = 今天 - offset）。
 *
 * 不写 `今天 - span * 86400000`：那是 span + 1 天。多出来的那一天看着无害，实际会让
 * 「最近 7 天」的合计把第 8 天也算进去，与热力图/趋势图同一窗口对不上。
 *
 * 跨天加减走 Date 的构造器溢出归一（夏令时那天只有 23 小时，毫秒乘法会错一格），
 * 与 ui/usage-activity.ts 的 shiftDays 同一个理由。
 */
function dayKeyOf(at: Date): DayKey {
  const month = String(at.getMonth() + 1).padStart(2, '0')
  const day = String(at.getDate()).padStart(2, '0')

  return `${at.getFullYear()}-${month}-${day}`
}

/** 最近 span 天的闭区间 [from, to]；span 至少 1 天。 */
export function windowOf(span: number, now: Date = new Date()): { readonly from: DayKey; readonly to: DayKey } {
  const days = Math.max(1, Math.floor(span))
  const from = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (days - 1))

  return { from: dayKeyOf(from), to: dayKeyOf(now) }
}

/** ctx.rpc(usageContract) 的薄封装 */
export function createUsageApi(ctx: UiFeatureContext) {
  const rpc: TypedRpcClient<typeof usageContract> = ctx.rpc(usageContract)

  return {
    tokenDays: (from: DayKey, to: DayKey): Promise<readonly TokenDay[]> =>
      rpc.call('usage.tokenDays', { from, to }).then((r: { days: TokenDay[] }) => r.days),
    modelDays: (from: DayKey, to: DayKey): Promise<readonly ModelDay[]> =>
      rpc.call('usage.modelDays', { from, to }).then((r: { rows: ModelDay[] }) => r.rows),
    messageCount: (from: DayKey, to: DayKey): Promise<number> =>
      rpc
        .call('usage.messageCount', { from, to })
        .then((r: { days: MessageCountDay[] }) => r.days.reduce((sum, day) => sum + day.count, 0)),

    /*
     * 三个「按窗口读」的函数，形状与 legacy 由组合根注入的那三个 props 一字不差
     * （readTokenDays / readModelDays / readMessageCount，入参都是天数）。
     *
     * **必须在 setup 里建一次、整份交下去**，不能在渲染期现造：用量页的 useRead 以
     * 「读函数」为 effect 依赖，每帧换一个引用就是每帧重读一次（读回 → setState →
     * 重渲染 → 又一个新函数），页面上表现为数字闪个不停。legacy 那三个 props 是
     * 组合根 useCallback 过的，同一条道理。
     */
    readTokenDays: (span: number): Promise<readonly TokenDay[]> => {
      const { from, to } = windowOf(span)

      return rpc.call('usage.tokenDays', { from, to }).then((r: { days: TokenDay[] }) => r.days)
    },
    readModelDays: (span: number): Promise<readonly ModelDay[]> => {
      const { from, to } = windowOf(span)

      return rpc.call('usage.modelDays', { from, to }).then((r: { rows: ModelDay[] }) => r.rows)
    },
    /** 最近 span 天里**用户发出去的句子数**（ADR 0039 / legacy 的 turn_admissions）。 */
    readMessageCount: (span: number): Promise<number> => {
      const { from, to } = windowOf(span)

      return rpc
        .call('usage.messageCount', { from, to })
        .then((r: { days: MessageCountDay[] }) => r.days.reduce((sum, day) => sum + day.count, 0))
    },
  }
}

export type UsageApi = ReturnType<typeof createUsageApi>
