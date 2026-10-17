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

/** 上下文面板底部那一排：都是 omp 的内置命令，顺序即按钮顺序；文案只是命令的中文名，行为全在 omp */
export const CONTEXT_COMMANDS = [
  { name: 'compact', label: '压缩', hint: '把较早的对话总结成摘要（/compact）' },
  { name: 'shake', label: '瘦身', hint: '丢掉工具结果与大段内容（/shake）' },
  { name: 'handoff', label: '交接', hint: '写一份交接文档并原地压缩（/handoff）' },
] as const
