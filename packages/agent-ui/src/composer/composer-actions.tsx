import type { PaletteEntry, SessionConfigControl } from '@poietica/agent-contract'
import { CloseIcon, PlusIcon, SkillIcon, TerminalIcon, ToolIcon } from '../primitives/icons'
import type { PaletteGroup } from './composer-palette'
import { usePromptInputActions } from './prompt-input'

/*
 * 加号那一侧：往这一句里加什么。
 *
 * 面板本身归输入框 —— 它锚在卡的上沿，与斜杠触发的是同一张，键盘也因此只有一套。
 * 这里只剩下扳机和一次投影。
 *
 * 档位那几组不是本文件编出来的：它们是 agent 报的 mode / other 两类选择器
 * （ACP session config options）。agent 没报就没有那一组 —— 画一行点不动的
 * 灰字等于告诉用户"这里坏了"。
 */

export function ComposerActions() {
  const { togglePalette } = usePromptInputActions()

  return (
    <button
      aria-label="添加内容"
      className="assistant-control--ghost"
      onClick={togglePalette}
      type="button"
    >
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

    groups.push({
      id: control.id,
      heading: control.label,
      rows: control.choices.map((choice) => ({
        id: `${control.id}:${choice.value}`,
        icon: <ToolIcon aria-hidden="true" />,
        label: choice.label,
        ...(choice.detail === undefined ? {} : { detail: choice.detail }),
        checked: choice.value === control.current,
        action: {
          kind: 'run' as const,
          run: () => {
            if (choice.value !== control.current) {
              onSelectControl(control.id, choice.value)
            }
          },
        },
      })),
    })
  }

  const skills = palette.filter((entry) => entry.kind === 'skill')
  const commands = palette.filter((entry) => entry.kind !== 'skill')

  if (skills.length > 0) {
    groups.push({ id: 'skills', heading: '技能', rows: skills.map((entry) => row(entry, true)) })
  }

  if (commands.length > 0) {
    groups.push({
      id: 'commands',
      heading: '命令',
      rows: commands.map((entry) => row(entry, false)),
    })
  }

  return groups
}

function row(entry: PaletteEntry, skill: boolean) {
  return {
    id: entry.name,
    icon: skill ? <SkillIcon aria-hidden="true" /> : <TerminalIcon aria-hidden="true" />,
    label: skill ? entry.title : entry.label,
    ...(entry.description === '' ? {} : { detail: entry.description }),
    token: entry.label,
    action: { kind: 'insert' as const, snippet: entry.label },
  }
}

/*
 * 生效档位的胶囊，站在批准方式旁边。
 *
 * 首档是 agent 摆在最前的常态档（ACP 规定 options 的顺序就是渲染顺序），所以
 * 停在首档时这里什么都不画 —— 常态不需要标记。摘掉就是切回首档，与面板里点那
 * 一行走同一条写入路径。
 */
export interface ComposerModeChipProps {
  readonly controls: readonly SessionConfigControl[]
  readonly onSelect: (controlId: string, value: string) => void
}

export function ComposerModeChip({ controls, onSelect }: ComposerModeChipProps) {
  const mode = controls.find((control) => control.purpose === 'mode')

  if (mode === undefined) {
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
