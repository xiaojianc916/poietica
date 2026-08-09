/**
 * 本地账本里的轮次计时，贴回重放出来的 spans 上。
 *
 * 与 attachImages 是同一类合流：内容来自 agent 的重放，计时来自这台机器的
 * 账本，两侧没有共同的 id，对齐只能靠数数 —— 而且是倒着数：账本的计数 N
 * 盖住的是最后 N 条用户消息（迁移 0011 的约定），所以账本的第 o 轮对应
 * 重放出来的第 o - N + 1 轮（重放的轮次从末端数，末轮恒为 0）。
 *
 * 对不上的保持重放算出的样子。账本会漏：半路 crash 的那一轮没有落定的一端，
 * 0014 之前的旧对话一行都没有。漏了就退回退化显示，不把别的轮的耗时挂到
 * 这一轮头上 —— 一个错的数字比一个退化的数字更难被发现。
 */

import type { TurnSpanTiming } from '@poietica/agent-contract'
import type { TimelineState } from './timeline-contract'

/**
 * 把账本记下的两端贴到重放出来的 spans 上。
 *
 * 一条都没贴上时原样交回入参：引用不变，下游按引用比较的投影缓存不被打掉
 *（与 foldFeed 的同一条规矩）。
 */
export function restampTurns(
  state: TimelineState,
  recorded: readonly TurnSpanTiming[],
  prompts: number,
): TimelineState {
  if (recorded.length === 0 || state.spans.length === 0) {
    return state
  }

  /* 账本轮号 → 重放轮号：末轮对末轮。 */
  const ledger = new Map<number, TurnSpanTiming>()

  for (const row of recorded) {
    ledger.set(row.turn - prompts + 1, row)
  }

  let touched = false

  const spans = state.spans.map((span) => {
    const held = ledger.get(span.turn)

    if (held === undefined) {
      return span
    }

    touched = true

    return { ...span, startedAt: held.startedAt, endedAt: held.endedAt }
  })

  return touched ? { ...state, spans } : state
}
