/*
 * 一条对话现在处于哪些模式。
 *
 * 协议一轮只收一段文字（agent-runtime 的 Command::Prompt），所以模式必须在送出
 * 之前落成文字，而且只落一次 —— 就在这里。旁白包进 system-reminder，投影一侧按
 * 同一条规则剥掉（projection.ts 的 saidByUser），所以屏幕上只有人自己说的话。
 */

const NAMES = ['goal', 'swarm'] as const

/** 这条对话自己的模式。agent 报的那几档是选择器，不在这里。 */
export type RunModeName = (typeof NAMES)[number]

export type RunMode = { readonly [name in RunModeName]: boolean }

export const NO_MODES: RunMode = { goal: false, swarm: false }

const NARRATION: { readonly [name in RunModeName]: string } = {
  goal: '目标模式：把下面这句话当作要持续追求的目标，达成之前每一轮自己接着推进。',
  swarm: '蜂群模式：把这件事里可并行的部分拆开，派多个子代理同时做，最后由你汇总结论。',
}

/** 送出去的那一段文字：旁白在前，人打的字在最后。 */
export function composePrompt(modes: RunMode, text: string): string {
  const said = text.trim()
  const standing = NAMES.filter((name) => modes[name]).map((name) => NARRATION[name])

  return standing.length === 0
    ? said
    : `<system-reminder>\n${standing.join('\n')}\n</system-reminder>\n${said}`
}

/** 空正文也发得出去：带着模式的一句是一句完整的话。 */
export function hasModes(modes: RunMode): boolean {
  return NAMES.some((name) => modes[name])
}
