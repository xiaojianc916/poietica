/*
 * 对话里敲得出来的那些斜杠命令。
 *
 * 表由 agent 算：它随会话事件里 commands 那一支整表到达，所以处理是整表替换，
 * 没有会与 agent 分叉的累积状态。技能不在这张表里 —— 它有自己的目录与激活动作
 * （AgentSkillPort）。
 */

/** 表里的一条。 */
export interface PaletteEntry {
  /** agent 认的那个名字，也就是斜杠后面敲的东西。 */
  readonly name: string
  /** 屏幕上显示的调用式。 */
  readonly label: string
  /** agent 给的那句说明。没给就是空串。 */
  readonly description: string
}

/**
 * 命令表这一路。
 *
 * 读一次，或者听它自己改主意。没有 select —— 命令不是可调项，敲它才是使用它。
 */
export interface AgentPalettePort {
  /** 此刻这张表。还没收到过任何一份时是空的。 */
  readonly read: () => readonly PaletteEntry[]
  /** 听"表变了"。返回退订。 */
  readonly subscribe: (listener: () => void) => () => void
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * 一份线上载荷里的那张表，如果它确实是一张表。
 *
 * 交回 undefined 表示"这一条不是命令表"，空数组表示"表是空的"：前者不该覆盖
 * 已经收到的那一份，后者该。
 */
export function paletteFrom(payload: unknown): readonly PaletteEntry[] | undefined {
  if (!isRecord(payload) || !Array.isArray(payload['commands'])) {
    return undefined
  }

  const entries: PaletteEntry[] = []

  for (const offered of payload['commands']) {
    if (!isRecord(offered) || typeof offered['name'] !== 'string') {
      continue
    }

    const said = offered['description']

    entries.push({
      name: offered['name'],
      label: `/${offered['name']}`,
      description: typeof said === 'string' ? said : '',
    })
  }

  return entries
}
