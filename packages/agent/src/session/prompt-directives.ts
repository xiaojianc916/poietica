/*
 * 这一句由什么构成：技能调用、指令、正文。
 *
 * 协议一轮只收一段文字（agent-runtime 的 Command::Prompt 是 text 加图片），所以
 * 「这一句要求什么」必须在送出之前落成文字，而且只落一次 —— 就在这里。屏幕上那
 * 一句与送出去的那一句因此是同一段字节。文案是界面自己的字。
 */

/** 面板里那一条技能：调用式原样带着，标题给屏幕看，两者都不在别处拼出来。 */
export interface SkillCall {
  /** agent 报的调用式，例如 `/skill:find-skills`。 */
  readonly call: string
  /** 屏幕上的名字。 */
  readonly title: string
}

export interface PromptDirectives {
  /** 这一句调用的技能。一句一个：调用式不叠加。 */
  readonly skill: SkillCall | null
  /** 要持续追求的目标。每一轮随那句话重述一次，agent 才追得住。 */
  readonly goal: string | null
  /** 把可并行的部分拆给子代理并行做；子代理在屏幕上是主时间线的工具卡（ADR 0017）。 */
  readonly swarm: boolean
}

export const NO_DIRECTIVES: PromptDirectives = { skill: null, goal: null, swarm: false }

const SWARM = '蜂群模式：把这件事里可并行的部分拆开，派多个子代理同时做，最后由你汇总结论。'

/** 送出去的那一段文字：调用式在最前，指令随后，人打的字在最后。 */
export function composePrompt(directives: PromptDirectives, text: string): string {
  const lines: string[] = []
  const goal = directives.goal?.trim() ?? ''
  const said = text.trim()

  if (directives.skill !== null) {
    lines.push(directives.skill.call)
  }

  if (goal.length > 0) {
    lines.push(`目标（持续追求）：${goal}`)
  }

  if (directives.swarm) {
    lines.push(SWARM)
  }

  if (said.length > 0) {
    lines.push(said)
  }

  return lines.join('\n')
}

/** 空正文也发得出去：带着指令的一句是一句完整的话。 */
export function hasDirectives(directives: PromptDirectives): boolean {
  return directives.skill !== null || (directives.goal?.trim().length ?? 0) > 0 || directives.swarm
}

/** 送出之后还留着的：技能是一次调用，目标与蜂群是持续的。 */
export function retainedDirectives(directives: PromptDirectives): PromptDirectives {
  return directives.skill === null ? directives : { ...directives, skill: null }
}
