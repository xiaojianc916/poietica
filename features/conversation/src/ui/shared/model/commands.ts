import type { CommandOutputTone, SlashCommand } from '@poietica/engine'

/**
 * 一条命令最近一次给人的话（引擎的 commands.output，或执行失败的原因）。不进会话文件、不画进输入框上方：
 * 表面把它变成一条横幅（色调由认得原句的引擎适配器定）。`seq` 每来一句就加一 —— 同一句话连说两次也得再报一次。
 */
export interface CommandOutputNotice {
  readonly seq: number
  /** 说这句话的那条命令（`/rename`），横幅据此给补救动作（改名失败 → 手动改名） */
  readonly command: string
  readonly text: string
  readonly tone: CommandOutputTone
}

/**
 * 一条对话的斜杠命令面：表与执行都归 omp（经 Core 的 commands.*）。GUI 列哪些、怎么呈现由清单定（home/command-manifest.ts），
 * 这里只是表、执行与最近一句输出。
 */
export interface ThreadCommands {
  readonly list: readonly SlashCommand[]
  readonly output: CommandOutputNotice | null
  /** 执行一句以 `/` 开头的输入；失败（忙、没有这条命令）写进 output（错误色调），不抛 */
  readonly run: (text: string) => Promise<void>
}

/** 命令面板的分组，按用途而不是按来源；次序就是空查询时面板的次序 */
export type CommandGroupId =
  | 'conversation'
  | 'mode'
  | 'model'
  | 'workflow'
  | 'settings'
  | 'custom'
  | 'extension'
  | 'mcp'

export const COMMAND_GROUPS: readonly { readonly id: CommandGroupId; readonly heading: string }[] = [
  { id: 'conversation', heading: '对话' },
  { id: 'mode', heading: '模式' },
  { id: 'model', heading: '模型与推理' },
  { id: 'workflow', heading: '工作流' },
  { id: 'settings', heading: '设置' },
  { id: 'custom', heading: '自定义命令' },
  { id: 'extension', heading: '扩展命令' },
  { id: 'mcp', heading: 'MCP 提示词' },
]

/** 选项型参数的一项：`value` 是要交给命令的原词（`on`、`provider/id`），`label` 是给人看的 */
export interface CommandChoice {
  readonly value: string
  readonly label: string
  readonly detail?: string | undefined
}

/**
 * 命令要什么参数，决定面板选中它之后的下一步：
 * - none：回车直接执行；
 * - choice：回车进二级选项（勾着当前值），选一项就执行；
 * - text：回车时必填的先停下来等人写、可选的直接执行（Tab 总是先写参数）。
 */
export type CommandInput =
  | { readonly kind: 'none' }
  | {
      readonly kind: 'choice'
      readonly choices: readonly CommandChoice[]
      /** 当前生效的那一项（面板里打勾、行尾显示）；不知道就缺席 */
      readonly current?: string | undefined
    }
  | { readonly kind: 'text'; readonly required: boolean; readonly placeholder: string }

/** 输入框面板要画的那一条命令：只有呈现所需的几格，执行归表面（AvailableCommand 在其上加执行方式） */
export interface ComposerCommand {
  readonly name: string
  readonly aliases: readonly string[]
  readonly description: string
  readonly group: CommandGroupId
  readonly input: CommandInput
}

/** 一句话是不是在点名一条命令：只认行首 `/名字`（名字到空白或冒号为止，与 omp 的 parseSlashCommand 同一个切法） */
export function commandNameOf(text: string): string | null {
  const line = text.trimStart()
  if (!line.startsWith('/')) return null
  const body = line.slice(1)
  const end = body.search(/[\s:]/)
  const name = end === -1 ? body : body.slice(0, end)
  return name === '' ? null : name
}

/** 命令名之后的那一截（去掉首尾空白）；不是命令交回空串 */
export function commandArgsOf(text: string): string {
  const line = text.trimStart()
  if (!line.startsWith('/')) return ''
  return line
    .slice(1)
    .replace(/^[^\s:]+:?/, '')
    .trim()
}

/** 按名字或别名在表里找一条（表可以是 omp 的 SlashCommand，也可以是面板的 ComposerCommand） */
export function findCommand<T extends { readonly name: string; readonly aliases: readonly string[] }>(
  list: readonly T[],
  name: string,
): T | null {
  return list.find((command) => command.name === name || command.aliases.includes(name)) ?? null
}

/** 一句话点名的是不是 omp 表里的一条 */
export function matchCommand(list: readonly SlashCommand[], text: string): SlashCommand | null {
  const name = commandNameOf(text)
  return name === null ? null : findCommand(list, name)
}

/**
 * 草稿此刻是哪一段斜杠输入：整份草稿只有一行、以 `/` 开头。`rest` 为 null = 还在敲名字（可以是空串，刚敲下 `/` 那一刻）；
 * 不为 null = 名字之后已经敲了空格，`rest` 是空格之后的那一截（可以是空串）。不是斜杠输入交回 null。
 */
export function slashStateOf(text: string): { readonly name: string; readonly rest: string | null } | null {
  if (text.includes('\n')) return null
  const hit = /^\/(\S*)(?: ([\s\S]*))?$/.exec(text)
  if (hit === null) return null
  return { name: hit[1] ?? '', rest: hit[2] ?? null }
}

/* 匹配档：名字相等 > 名字前缀 > 别名前缀 > 名字含这截 > 说明含这截（说明是中文，敲 `/压缩` 也找得到 /compact）。 */
function matchRankOf(command: ComposerCommand, query: string): number | null {
  const name = command.name.toLowerCase()
  if (name === query) return 0
  if (name.startsWith(query)) return 1
  if (command.aliases.some((alias) => alias.toLowerCase().startsWith(query))) return 2
  if (name.includes(query)) return 3
  if (command.description.toLowerCase().includes(query)) return 4
  return null
}

/** 按草稿那一截挑出命令并排好：先按匹配档，同档保持表的次序（表的次序就是常用程度）；空串交回整张表 */
export function rankCommands<T extends ComposerCommand>(list: readonly T[], query: string): readonly T[] {
  const wanted = query.toLowerCase()
  if (wanted === '') return list
  return list
    .map((command, at) => ({ at, command, rank: matchRankOf(command, wanted) }))
    .filter((entry): entry is { at: number; command: T; rank: number } => entry.rank !== null)
    .sort((a, b) => a.rank - b.rank || a.at - b.at)
    .map((entry) => entry.command)
}

/** 选项按敲的那一截过滤：原词或名字前缀优先，其次包含；空串交回全部 */
export function rankChoices(choices: readonly CommandChoice[], query: string): readonly CommandChoice[] {
  const wanted = query.trim().toLowerCase()
  if (wanted === '') return choices
  const rankOf = (choice: CommandChoice): number | null => {
    const value = choice.value.toLowerCase()
    const label = choice.label.toLowerCase()
    if (value === wanted || label === wanted) return 0
    if (value.startsWith(wanted) || label.startsWith(wanted)) return 1
    if (value.includes(wanted) || label.includes(wanted)) return 2
    return null
  }
  return choices
    .map((choice, at) => ({ at, choice, rank: rankOf(choice) }))
    .filter((entry): entry is { at: number; choice: CommandChoice; rank: number } => entry.rank !== null)
    .sort((a, b) => a.rank - b.rank || a.at - b.at)
    .map((entry) => entry.choice)
}
