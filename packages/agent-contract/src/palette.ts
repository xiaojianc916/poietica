/*
 * 对话里敲得出来的那些斜杠命令。
 *
 * 表由 agent 算，不由本应用算。ACP 只有一条路说这件事：session/update 里的
 * available_commands_update，载荷恒为整表。agent 在会话建好之后、装载结束之后
 * 各报一次，此后每次那张表变了再报 —— 所以"有哪些技能"这个问题的答案只在这条
 * 通知里。
 *
 * 本应用因此不扫盘，也不认识任何一层技能目录。上游把内置命令、它自己认得的技能
 * （$KIMI_CODE_HOME/skills、~/.agents/skills、.kimi-code/skills、.agents/skills，
 * 按 Project > User > Extra > Built-in 覆盖）与插件带来的合成一张表再报过来。在
 * 这一侧复算一遍，就是给同一件事造第二个事实来源，而它注定与上游的分层规则漂开。
 */

/** 一条命令的出身。 */
export type PaletteKind = 'builtin' | 'command' | 'skill'

/** 表里的一条。 */
export interface PaletteEntry {
  /** 它是哪一类。 */
  readonly kind: PaletteKind
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
 * 与 AgentCapabilityPort 同一个形状：读一次，或者听它自己改主意。没有 select ——
 * 命令不是可调项，敲它才是使用它。
 */
export interface AgentPalettePort {
  /** 此刻这张表。还没收到过任何一份时是空的。 */
  readonly read: () => readonly PaletteEntry[]
  /** 听"表变了"。返回退订。 */
  readonly subscribe: (listener: () => void) => () => void
}

/*
 * 技能在表里的写法。
 *
 * 上游把技能注册成 `skill:<name>`，斜杠菜单里两种敲法都认（它的 slash 解析先按
 * 原名查，再按这个前缀查）。所以前缀是判据，不是显示内容。
 */
const SKILL_PREFIX = 'skill:'

/*
 * agent 自带的那几条。
 *
 * 它们既不是技能也不是插件命令，混进去会让"技能"那一格凭空多出六条。名单取自上游
 * 的内置斜杠命令名单。
 */
const BUILTIN_NAMES: ReadonlySet<string> = new Set([
  'compact',
  'help',
  'mcp',
  'status',
  'tasks',
  'usage',
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** 一条命令，按它的名字定出身与调用式。 */
export function paletteEntryOf(name: string, description: string): PaletteEntry {
  if (name.startsWith(SKILL_PREFIX)) {
    return {
      kind: 'skill',
      name,
      label: `/skill:${name.slice(SKILL_PREFIX.length)}`,
      description,
    }
  }

  return {
    kind: BUILTIN_NAMES.has(name) ? 'builtin' : 'command',
    name,
    label: `/${name}`,
    description,
  }
}

/**
 * 一份线上载荷里的那张表，如果它确实是一张表。
 *
 * 交回 undefined 表示"这一条不是命令表"，空数组表示"表是空的"。两者必须分得开：
 * 前者不该覆盖已经收到的那一份，后者该。
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

    entries.push(paletteEntryOf(offered['name'], typeof said === 'string' ? said : ''))
  }

  return entries
}
