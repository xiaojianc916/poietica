/**
 * 本地账本里的轮次计时，贴回重放出来的 spans 上。
 *
 * 耗时的唯一真相在这本账里。agent 经 session/load 交还的历史不带任何原来的时刻
 *（协议里没有这一格），所以「这一轮花了多久」在重放那一侧根本不存在 —— 拿条目的
 * at 去减，减出来的是历史被读回来的那一段。
 *
 * 与 attachImages 是同一类合流，用的因此是同一把尺子：两侧没有共同的 id，对齐只能
 * 靠数数，而且是倒着数 —— 账本的计数 N 盖住的是最后 N 条用户消息（迁移 0011 的
 * 约定），账本的第 o 轮因此对应重放出来的第 o - N + 1 轮（重放的轮次从末端数，末轮
 * 恒为 0）。
 *
 * 对不齐就整批不认领，并且说出来 —— 也与 attachImages 同一条规矩。一次记了账却没
 * 能成为一轮的提问（发出去就失败的那种）会把它之前每一轮的号都推错一格，那时每一
 * 条耗时都可能挂在别人头上；而一个错的数字比一个空的数字更难被发现。
 *
 * 账本盖不住的轮次原样交回：它们没有两端，封条因此不报耗时（turn-fold 的 sealOf 与
 * turn-seal 的 useElapsed 读的是同一个缺席）。缺一段前史是常态 —— 0014 之前的对话
 * 一行都没有，那是尺子的起点在后面，不是尺子错了。
 */

import type { TurnSpanTiming } from '@poietica/agent-contract'
import type { TimelineState } from './timeline-contract'
import { appendLocalError } from './timeline-reducer'

export function restampTurns(
  state: TimelineState,
  recorded: readonly TurnSpanTiming[],
  prompts: number,
): TimelineState {
  if (recorded.length === 0 || state.spans.length === 0) {
    return state
  }

  const ledger = aligned(state, recorded, prompts)

  if (ledger === undefined) {
    return unaligned(state, recorded.length, prompts)
  }

  const spans = state.spans.map((span) => {
    const held = ledger.get(span.turn)

    return held === undefined ? span : { ...span, startedAt: held.startedAt, endedAt: held.endedAt }
  })

  return { ...state, spans }
}

/**
 * 账本轮号 → 重放轮号。有一行落在这段经过之外就交回 undefined，一条都不贴。
 *
 * 判据只有这一条，因为只有这一条是数得出来的：账本记着的那一轮，在重放出来的经过
 * 里必须真的存在。落在外面说明两侧数出来的不是同一件事 —— 重放合并或丢掉了消息，
 * 或者中间有一次提问从来没有成为一轮。
 */
function aligned(
  state: TimelineState,
  recorded: readonly TurnSpanTiming[],
  prompts: number,
): Map<number, TurnSpanTiming> | undefined {
  const known = new Set(state.spans.map((span) => span.turn))
  const ledger = new Map<number, TurnSpanTiming>()

  for (const row of recorded) {
    const turn = row.turn - prompts + 1

    if (!known.has(turn)) {
      return undefined
    }

    ledger.set(turn, row)
  }

  return ledger
}

/**
 * 这批耗时没能贴回原处，说一声。
 *
 * 走的是本地事故那条既有通道（appendLocalError），与 attachImages 的同名分支同一条
 * 横线：两者都发生在任何一帧之外，日志里都没有对应的帧。endsTurn 为假 —— 这不是某
 * 一轮失败了。两个数字写进这句话，因为它们正是判断出在哪一侧的全部依据。
 */
function unaligned(state: TimelineState, rows: number, prompts: number): TimelineState {
  const last = state.items[state.items.length - 1]

  return appendLocalError(state, {
    message: `这条对话有 ${String(rows)} 轮的耗时没能贴回原处：账本记着 ${String(
      prompts,
    )} 轮，重放出来 ${String(state.spans.length)} 轮。`,
    at: last?.at ?? 0,
    endsTurn: false,
  })
}
