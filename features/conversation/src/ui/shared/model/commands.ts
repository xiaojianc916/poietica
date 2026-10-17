import type { SlashCommand } from '@poietica/engine'

/**
 * 一条对话的斜杠命令面：表与执行都归 omp（经 Core 的 commands.*），这里只是屏幕要的那几格。
 * `output` 只留**最近一条命令**的输出：它不进会话文件，换一条命令就换一块，不在屏幕上越积越长。
 */
export interface ThreadCommands {
  readonly list: readonly SlashCommand[]
  readonly output: { readonly command: string; readonly lines: readonly string[] } | null
  /** 执行一句以 `/` 开头的输入；失败（忙、没有这条命令）写进 output，不抛 */
  readonly run: (text: string) => Promise<void>
  readonly dismissOutput: () => void
}

/** 一句话是不是在点名表里的一条命令：只认行首 `/名字`（名字到空白或冒号为止，与 omp 的 parseSlashCommand 同一个切法） */
export function matchCommand(list: readonly SlashCommand[], text: string): SlashCommand | null {
  const line = text.trimStart()
  if (!line.startsWith('/')) return null
  const body = line.slice(1)
  const end = body.search(/[\s:]/)
  const name = end === -1 ? body : body.slice(0, end)
  if (name === '') return null
  return list.find((command) => command.name === name || command.aliases.includes(name)) ?? null
}

/**
 * 表里有没有这条命令：图形界面上的快捷按钮只是命令的快捷方式，按钮在不在由 omp 的命令表说了算，不在本仓写死。
 * 表还没读到时（入口页、会话起不来）按「没有」处理，快捷按钮不画，而不是让整个表面崩掉。
 */
export function hasCommand(list: readonly SlashCommand[] | undefined, name: string): boolean {
  return list?.some((command) => command.name === name) ?? false
}

/**
 * 草稿是不是正在敲一条命令的名字：整份草稿就是行首 `/` 加一截不带空白的字（可以是空串，刚敲下 `/` 那一刻）。
 * 是就交回那一截，不是（还没敲斜杠、已经在写参数、换了行）交回 null —— 命令面板只在前一种时候出来。
 */
export function slashQueryOf(text: string): string | null {
  const hit = /^\/(\S*)$/.exec(text)
  return hit === null ? null : (hit[1] ?? '')
}

/** 选中这条命令时要不要先补参数：omp 的参数提示里 `<…>` 是必填、`[…]` 是可选（可选的直接执行） */
export function requiresArgument(command: SlashCommand): boolean {
  return command.hint?.trimStart().startsWith('<') ?? false
}

/* 匹配档：名字相等 > 名字前缀 > 别名前缀 > 名字含这截 > 说明含这截（说明是中文，敲 `/压缩` 也找得到 /compact）。 */
function matchRankOf(command: SlashCommand, query: string): number | null {
  const name = command.name.toLowerCase()
  if (name === query) return 0
  if (name.startsWith(query)) return 1
  if (command.aliases.some((alias) => alias.toLowerCase().startsWith(query))) return 2
  if (name.includes(query)) return 3
  if (command.description?.toLowerCase().includes(query) === true) return 4
  return null
}

/** 按草稿那一截挑出命令并排好：先按匹配档，同档保持表的次序（表的次序就是常用程度）；空串交回整张表 */
export function rankCommands(list: readonly SlashCommand[], query: string): readonly SlashCommand[] {
  const wanted = query.toLowerCase()
  if (wanted === '') return list
  return list
    .map((command, at) => ({ at, command, rank: matchRankOf(command, wanted) }))
    .filter((entry): entry is { at: number; command: SlashCommand; rank: number } => entry.rank !== null)
    .sort((a, b) => a.rank - b.rank || a.at - b.at)
    .map((entry) => entry.command)
}

/** 命令面板的分组：人自己写的命令在前（最可能是来找它的），内置命令最后；同一组里的先后由 rankCommands 定 */
export const COMMAND_GROUPS: readonly {
  readonly id: string
  readonly heading: string
  readonly sources: readonly SlashCommand['source'][]
}[] = [
  { id: 'custom', heading: '自定义命令', sources: ['file', 'custom'] },
  { id: 'extension', heading: '扩展命令', sources: ['extension'] },
  { id: 'mcp', heading: 'MCP 提示词', sources: ['mcp_prompt'] },
  { id: 'builtin', heading: '内置命令', sources: ['builtin'] },
]

/** 上下文面板底部那一排：都是 omp 的内置命令，顺序即按钮顺序；文案只是命令的中文名，行为全在 omp */
export const CONTEXT_COMMANDS = [
  { name: 'compact', label: '压缩', hint: '把较早的对话总结成摘要（/compact）' },
  { name: 'shake', label: '瘦身', hint: '丢掉工具结果与大段内容（/shake）' },
  { name: 'handoff', label: '交接', hint: '写一份交接文档并原地压缩（/handoff）' },
] as const
