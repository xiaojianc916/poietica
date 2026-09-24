/*
 * 一轮的结局。
 *
 * `agent_end` 自己不带结局 —— 上游把它放在最后一条 assistant 消息的 `stopReason`
 * 上。官方就是这么判的：modes/print-mode.ts 的 terminalFailure 读
 * `assistantMsg.stopReason`，并用 isSilentAbort 把「上游内部的静默中止」排除在外
 * （那种中止后面还会接着跑，不是失败）。
 *
 * 一律报 completed 会把一次厂商报错说成一轮成功：屏幕上既没有正文也没有错误，
 * 人只看见一轮「做完了」。所以这一格必须由知道的人按上游的判据填。
 *
 * 纯函数，不碰 SDK 会话对象：能被单测逐条钉住。
 */

import { isSilentAbort } from '@oh-my-pi/pi-coding-agent/session/messages'

/** 结局的三档，与 crates/agent-client 的 turn_end outcome 逐字对应。 */
export interface TurnOutcome {
  readonly kind: 'completed' | 'cancelled' | 'failed'
  readonly message?: string
}

/** 分类只看这几格，所以入参就只要这几格。 */
interface TerminalMessage {
  readonly stopReason: string
  /** 与上游 AssistantMessage 的 `errorMessage?: string` 同形（可缺席，不是显式 undefined）。 */
  readonly errorMessage?: string
  readonly errorId?: number
}

/**
 * 最后一条 assistant 消息 → 这一轮的结局。
 *
 * - 没有消息，或是上游的静默中止：这一轮没有失败可言，按完成算。
 * - `aborted`：这一轮被停掉（人按了取消，或上游主动中止），不是它自己坏了。
 * - `error`：厂商或链路报错，`errorMessage` 就是给人看的那一句。
 */
export function outcomeOf(last: TerminalMessage | undefined): TurnOutcome {
  if (last === undefined || isSilentAbort(last)) {
    return { kind: 'completed' }
  }

  const message = last.errorMessage

  if (last.stopReason === 'aborted') {
    return { kind: 'cancelled', ...(message === undefined ? {} : { message }) }
  }

  if (last.stopReason === 'error') {
    return { kind: 'failed', ...(message === undefined ? {} : { message }) }
  }

  return { kind: 'completed' }
}
