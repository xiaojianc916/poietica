/*
 * 一条对话现在处于哪些模式。
 *
 * 协议一轮只收一段文字（agent-runtime 的 Command::Prompt），所以模式必须在送出
 * 之前落成文字，而且只落一次 —— 就在这里。屏幕上记的仍是人自己说的那句话。
 */

export interface RunMode {
  /** 要持续追求的目标：每一轮随那句话重述一次，agent 才追得住。 */
  readonly goal: string | null
  /** 把可并行的部分拆给子代理并行做。 */
  readonly swarm: boolean
}

export const NO_MODES: RunMode = { goal: null, swarm: false }

const SWARM = '蜂群模式：把这件事里可并行的部分拆开，派多个子代理同时做，最后由你汇总结论。'

/** 送出去的那一段文字：模式在前，人打的字在最后。 */
export function composePrompt(modes: RunMode, text: string): string {
  const lines: string[] = []
  const goal = modes.goal?.trim() ?? ''
  const said = text.trim()

  if (goal.length > 0) {
    lines.push(`目标（持续追求）：${goal}`)
  }

  if (modes.swarm) {
    lines.push(SWARM)
  }

  if (said.length > 0) {
    lines.push(said)
  }

  return lines.join('\n')
}

/** 空正文也发得出去：带着模式的一句是一句完整的话。 */
export function hasModes(modes: RunMode): boolean {
  return (modes.goal?.trim().length ?? 0) > 0 || modes.swarm
}
