import { permissionPostureOf } from '@poietica/agent'
import type { PaletteEntry, SessionConfigControl } from '@poietica/agent-contract'
import { CloseIcon, PlusIcon, SkillIcon, TerminalIcon, ToolIcon } from '../primitives/icons'
import type { PaletteGroup, PaletteRow } from './composer-palette'
import { usePromptInputActions } from './prompt-input'

/*
 * 加号那一侧：往这一句里加什么。
 *
 * 面板本身归输入框 —— 它锚在卡的上沿，与斜杠触发的是同一张，键盘也因此只有一套。
 * 这里只剩下扳机和一次投影。
 *
 * 面板只承载不属于批准方式的 mode（目前是 Plan）与 other 选择器。批准方式
 * 由 PermissionPicker 独占，不能再把 Auto / YOLO 作为第二套入口重复显示。
 */

export function ComposerActions() {
  const { togglePalette } = usePromptInputActions()

  return (
    <button aria-label="添加内容" className="assistant-plus" onClick={togglePalette} type="button">
      <PlusIcon aria-hidden="true" />
    </button>
  )
}

export interface ComposerPaletteSource {
  readonly controls: readonly SessionConfigControl[]
  readonly onSelectControl: (controlId: string, value: string) => void
  /** agent 报的命令表；技能与命令两组由它长出，与斜杠触发读同一张。 */
  readonly palette: readonly PaletteEntry[]
}

/**
 * agent 报的档位与命令，摊成面板的分组。
 *
 * 「添加文件」不在这里：它不来自 agent，归输入框自己那一组。
 */
export function composerPaletteGroups({
  controls,
  onSelectControl,
  palette,
}: ComposerPaletteSource): readonly PaletteGroup[] {
  const groups: PaletteGroup[] = []

  for (const control of controls) {
    if (control.purpose !== 'mode' && control.purpose !== 'other') {
      continue
    }

    const choices =
      control.purpose === 'mode'
        ? control.choices.filter((choice) => permissionPostureOf(choice.value) === undefined)
        : control.choices

    if (choices.length === 0) {
      continue
    }

    groups.push({
      id: control.id,
      heading: control.label,
      rows: choices.map(
        (choice): PaletteRow => ({
          id: `${control.id}:${choice.value}`,
          icon: <ToolIcon aria-hidden="true" />,
          label: choice.label,
          ...(choice.detail === undefined ? {} : { detail: choice.detail }),
          checked: choice.value === control.current,
          action: {
            kind: 'run',
            run: () => {
              if (choice.value !== control.current) {
                onSelectControl(control.id, choice.value)
              }
            },
          },
        }),
      ),
    })
  }

  const skills = palette.filter((entry) => entry.kind === 'skill')
  const commands = palette.filter((entry) => entry.kind !== 'skill')

  if (skills.length > 0) {
    groups.push({
      id: 'skills',
      heading: '技能',
      rows: skills.map((entry) => callable(entry, true)),
    })
  }

  if (commands.length > 0) {
    groups.push({
      id: 'commands',
      heading: '命令',
      rows: commands.map((entry) => callable(entry, false)),
    })
  }

  return groups
}

function callable(entry: PaletteEntry, skill: boolean): PaletteRow {
  return {
    id: entry.name,
    icon: skill ? <SkillIcon aria-hidden="true" /> : <TerminalIcon aria-hidden="true" />,
    label: skill ? entry.title : entry.label,
    ...(entry.description === '' ? {} : { detail: entry.description }),
    token: entry.label,
    action: { kind: 'insert', snippet: entry.label },
  }
}

/*
 * 批准方式之外的生效模式。
 *
 * manual / yolo / auto 由 PermissionPicker 唯一显示；这里只显示 Plan 等额外模式。
 * 摘掉就是切回首档，与面板里点那一行走同一条写入路径。
 */
export interface ComposerModeChipProps {
  readonly controls: readonly SessionConfigControl[]
  readonly onSelect: (controlId: string, value: string) => void
}

export function ComposerModeChip({ controls, onSelect }: ComposerModeChipProps) {
  const mode = controls.find((control) => control.purpose === 'mode')

  if (mode === undefined || permissionPostureOf(mode.current) !== undefined) {
    return null
  }

  const [first] = mode.choices
  const inForce = mode.choices.find((choice) => choice.value === mode.current)

  if (first === undefined || inForce === undefined || mode.current === first.value) {
    return null
  }

  return (
    <button
      aria-label={`退出${inForce.label}`}
      className="assistant-mode-chip"
      onClick={() => {
        onSelect(mode.id, first.value)
      }}
      type="button"
    >
      <CloseIcon aria-hidden="true" />

      <span className="assistant-mode-chip__label">{inForce.label}</span>
    </button>
  )
}
