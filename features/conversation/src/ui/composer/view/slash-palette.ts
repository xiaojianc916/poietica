import {
  COMMAND_GROUPS,
  type CommandChoice,
  type ComposerCommand,
  findCommand,
  rankChoices,
  rankCommands,
  slashStateOf,
} from '../../shared/model/commands'
import type { PaletteGroup, PaletteRow } from './composer-palette'

/*
 * 斜杠命令面板的行：草稿是一行以 `/` 开头的字时，PromptInput 用这几组代替加号面板。面板分三个阶段，全由草稿推出来
 * （没有第二份状态，删一个字就退回上一阶段）：
 *   1. `/名字`（还没敲空格）：命令列表，按用途分组；
 *   2. `/名字 …` 且命令是选项型：二级选项列表（勾着当前值），选一项就执行；
 *   3. `/名字 …` 且命令带文字参数：一行提示「回车执行什么」，必填的没写就选不动。
 * 不带参数的命令敲了空格之后面板收起 —— 回车照常提交。没有图标：一列全是命令，同一枚图标只是噪音。
 */

const NO_GROUPS: readonly PaletteGroup[] = []

function headingOf(command: ComposerCommand): string {
  return command.description === '' ? `/${command.name}` : `/${command.name} · ${command.description}`
}

/* 行尾：选项型显示当前值（不知道就只给「›」，表示还有下一层） */
function trailOf(command: ComposerCommand): string | undefined {
  if (command.input.kind !== 'choice') return undefined
  const { choices, current } = command.input
  const label = choices.find((entry) => entry.value === current)?.label
  return label === undefined ? '›' : `${label} ›`
}

/* 回车之后的下一步：不带参数、可选参数直接执行；选项型进二级、必填参数停下来等人写（都是补一个空格） */
function commandRow(command: ComposerCommand): PaletteRow {
  const name = `/${command.name}`
  const next = command.input.kind === 'choice' || (command.input.kind === 'text' && command.input.required)
  return {
    id: `slash:${command.group}:${command.name}`,
    label: name,
    ...(command.description === '' ? {} : { detail: command.description }),
    ...(trailOf(command) === undefined ? {} : { trail: trailOf(command) }),
    action: { kind: 'slash', fill: next ? `${name} ` : name, submit: !next, tab: `${name} ` },
  }
}

function choiceRow(command: ComposerCommand, entry: CommandChoice, current: string | undefined): PaletteRow {
  const text = `/${command.name} ${entry.value}`
  return {
    id: `slash:${command.name}:${entry.value}`,
    label: entry.label,
    ...(entry.detail === undefined ? {} : { detail: entry.detail }),
    ...(entry.value === current ? { checked: true } : {}),
    action: { kind: 'slash', fill: text, submit: true, tab: text },
  }
}

function argumentRow(command: ComposerCommand, rest: string, required: boolean, placeholder: string): PaletteRow {
  const text = `/${command.name} ${rest}`.trimEnd()
  const empty = rest.trim() === ''
  return {
    id: `slash:${command.name}:argument`,
    label: `/${command.name}`,
    argument: empty ? placeholder : rest.trim(),
    hint: empty && required ? '先写参数' : '回车执行',
    ...(empty && required ? { disabled: true } : {}),
    action: { kind: 'slash', fill: text, submit: true, tab: `${text} ` },
  }
}

/** 第 2、3 阶段：名字之后已经敲了空格 */
function argumentGroups(command: ComposerCommand, rest: string): readonly PaletteGroup[] {
  const { input } = command
  if (input.kind === 'none') return NO_GROUPS
  if (input.kind === 'text') {
    return [
      {
        id: `slash:${command.name}`,
        heading: headingOf(command),
        rows: [argumentRow(command, rest, input.required, input.placeholder)],
      },
    ]
  }
  const rows = rankChoices(input.choices, rest).map((entry) => choiceRow(command, entry, input.current))
  /* 一项都对不上（`/model opus` 这种模糊写法）：面板收起，回车交给表面按模糊匹配办 */
  return rows.length === 0 ? NO_GROUPS : [{ id: `slash:${command.name}`, heading: headingOf(command), rows }]
}

/**
 * 按草稿推出面板的组。第 1 阶段：还没敲字时按固定组序；敲了字就按每组最好的那一条排组 ——
 * 敲全了 `/compact`，它就该是回车选中的那一行，不被排在前面的组压下去。
 */
export function slashPaletteGroups(commands: readonly ComposerCommand[], text: string): readonly PaletteGroup[] {
  const state = slashStateOf(text)
  if (state === null) return NO_GROUPS
  if (state.rest !== null) {
    const command = findCommand(commands, state.name)
    return command === null ? NO_GROUPS : argumentGroups(command, state.rest)
  }
  const ranked = rankCommands(commands, state.name)
  const groups = COMMAND_GROUPS.map((group) => ({
    group,
    members: ranked.filter((command) => command.group === group.id),
  })).filter((entry) => entry.members.length > 0)

  if (state.name !== '') {
    const firstAt = (members: readonly ComposerCommand[]): number => {
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
