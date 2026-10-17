import type { SlashCommand } from '@poietica/engine'
import { COMMAND_GROUPS, rankCommands } from '../../shared/model/commands'
import type { PaletteGroup, PaletteRow } from './composer-palette'

/*
 * 斜杠命令面板的行：草稿敲下行首 `/` 时，PromptInput 用这几组代替加号面板。
 * 一行就是「名字 · 参数提示 · 说明」三格，与终端里的 agent 一个样子；没有图标 —— 一列全是命令，同一枚图标只是噪音。
 */

function commandRow(command: SlashCommand): PaletteRow {
  return {
    id: `slash:${command.source}:${command.name}`,
    label: `/${command.name}`,
    ...(command.hint === null || command.hint === '' ? {} : { argument: command.hint }),
    ...(command.description === null || command.description === '' ? {} : { detail: command.description }),
    action: { kind: 'command', command },
  }
}

/**
 * 按草稿那一截（`/` 之后的字）挑命令、分组。还没敲字时按固定组序（自定义在前、内置在后）；
 * 敲了字就按每组最好的那一条排组 —— 敲全了 `/compact`，它就该是回车选中的那一行，不被排在前面的自定义组压下去。
 */
export function slashPaletteGroups(commands: readonly SlashCommand[], query: string): readonly PaletteGroup[] {
  const ranked = rankCommands(commands, query)
  const groups = COMMAND_GROUPS.map((group) => ({
    group,
    members: ranked.filter((command) => group.sources.includes(command.source)),
  })).filter((entry) => entry.members.length > 0)

  if (query !== '') {
    const firstAt = (members: readonly SlashCommand[]): number => {
      const [first] = members
      return first === undefined ? ranked.length : ranked.indexOf(first)
    }
    groups.sort((a, b) => firstAt(a.members) - firstAt(b.members))
  }

  return groups.map(({ group, members }) => ({
    id: `slash:${group.id}`,
    heading: group.heading,
    rows: members.map(commandRow),
  }))
}
