import type { Interaction } from '@poietica/engine'

/**
 * 题组 ↔ 发起它的那次 ask 调用（Q1-E）。
 *
 * omp 的 ask 工具调 `askDialog(questions, { timeout, signal })` 时**不带调用号**（tools/ask.ts 的 `_toolCallId`
 * 没往下传），调用号只在 `tool_execution_start` / `_end` 事件里。时间线要把答过的题组折进那次调用的产出，
 * 认的正是这个号 —— 缺了它，答过的题组哪一页都锚不上、直接不上屏。
 *
 * 两边谁先到不确定：pi-agent-core 先 push 了 start 再执行工具，但订阅者经异步流收事件，askDialog 可能先到。
 * 所以双向延迟认领：调用先到就排进「等题」，题先到就排进「等号」，后到的一方按先来先配。
 * 一次 ask 执行只问一次 askDialog，一个号只配一组题；调用结束还没配上的号作废。
 */
export class AskCallTracker {
  /** 已开始、还没配上题组的 ask 调用号，按开始先后 */
  private readonly calls: string[] = []
  /** 已发出、还没配上调用号的题组，按发出先后 */
  private readonly waiting: Interaction[] = []
  /** 题组号 → 调用号 */
  private readonly bound = new Map<string, string>()

  /** 一次 ask 调用开始：有等号的题组就配给最早那一组并交回它（调用方据此重发那张卡），否则排队等题 */
  started(toolCallId: string): Interaction | null {
    const asked = this.waiting.shift()
    if (asked === undefined) {
      this.calls.push(toolCallId)
      return null
    }
    this.bound.set(asked.id, toolCallId)
    return asked
  }

  /** 调用结束：还没配上题组的号作废（校验失败、空题组这些路径根本不问人） */
  ended(toolCallId: string): void {
    const at = this.calls.indexOf(toolCallId)
    if (at >= 0) this.calls.splice(at, 1)
  }

  /** 一组题发出：有等题的调用就配上最早那一次并交回号，否则排队等号 */
  requested(interaction: Interaction): string | undefined {
    if (interaction.kind !== 'question') return undefined
    const call = this.calls.shift()
    if (call === undefined) {
      this.waiting.push(interaction)
      return undefined
    }
    this.bound.set(interaction.id, call)
    return call
  }

  /** 一组题收口：交回配上的号（收口那张卡也得带着它，整条替换才不把号冲掉），并忘掉这一组 */
  resolved(interactionId: string): string | undefined {
    const at = this.waiting.findIndex((entry) => entry.id === interactionId)
    if (at >= 0) this.waiting.splice(at, 1)
    const call = this.bound.get(interactionId)
    this.bound.delete(interactionId)
    return call
  }
}
