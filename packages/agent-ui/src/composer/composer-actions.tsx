import { permissionPostureOf } from '@poietica/agent'
import type { AgentSkill, PaletteEntry, SessionConfigControl } from '@poietica/agent-contract'
import type { ReactNode } from 'react'
import {
  CloseIcon,
  PlusIcon,
  SirenIcon,
  SkillIcon,
  TerminalIcon,
  ToolIcon,
} from '../primitives/icons'
import type { PaletteGroup, PaletteRow } from './composer-palette'
import { usePostureMemory } from './posture-memory'
import { usePromptInputActions } from './prompt-input'

/*
 * 加号那一侧：往这一句里加什么。
 *
 * 面板本身归输入框 —— 它锚在卡的上沿，与斜杠触发的是同一张，键盘也因此只有一套。
 * 这里只剩下扳机和一次投影：agent 报的模式、技能、命令与 other 选择器各立一组。
 * 批准方式由 PermissionPicker 独占，不能再把 Auto / YOLO 作为第二套入口重复显示。
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
  /** agent 报的命令表。 */
  readonly palette: readonly PaletteEntry[]
  /** 这条会话能用的技能，由 kap 报。 */
  readonly skills: readonly AgentSkill[]
  /** 激活一条技能：一次协议动作，不往草稿里落字。 */
  readonly onActivateSkill: (name: string) => void
}

/* 选择器里的一行：生效的一档打勾，点下去写回 agent。图标由调用方按用途给。 */
function controlRow(
  control: SessionConfigControl,
  choice: SessionConfigControl['choices'][number],
  onSelectControl: (controlId: string, value: string) => void,
  icon: PaletteRow['icon'],
): PaletteRow {
  return {
    id: `${control.id}:${choice.value}`,
    icon,
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
  }
}

/**
 * agent 报的模式、技能、命令与 other 选择器，摊成面板的分组。
 *
 * 「添加文件」不在这里：它不来自 agent，归输入框自己那一组。
 */
export function composerPaletteGroups({
  controls,
  onActivateSkill,
  onSelectControl,
  palette,
  skills,
}: ComposerPaletteSource): readonly PaletteGroup[] {
  const groups: PaletteGroup[] = []
  const modes: PaletteRow[] = []

  for (const control of controls) {
    if (control.purpose !== 'mode') {
      continue
    }

    for (const choice of control.choices) {
      /* 批准方式由 PermissionPicker 独占，不在这张表里出现第二次。 */
      if (permissionPostureOf(choice.value) === undefined) {
        modes.push(controlRow(control, choice, onSelectControl, <SirenIcon aria-hidden="true" />))
      }
    }
  }

  if (modes.length > 0) {
    groups.push({ id: 'modes', heading: '模式', rows: modes })
  }

  for (const control of controls) {
    if (control.purpose !== 'other' || control.choices.length === 0) {
      continue
    }

    groups.push({
      id: control.id,
      heading: control.label,
      rows: control.choices.map((choice) =>
        controlRow(control, choice, onSelectControl, <ToolIcon aria-hidden="true" />),
      ),
    })
  }

  if (skills.length > 0) {
    groups.push({
      id: 'skills',
      heading: '技能',
      rows: skills.map((skill) => ({
        id: `skill:${skill.name}`,
        icon: <SkillIcon aria-hidden="true" />,
        label: skill.name,
        ...(skill.description === '' ? {} : { detail: skill.description }),
        token: `/skill:${skill.name}`,
        action: {
          kind: 'run' as const,
          run: () => {
            onActivateSkill(skill.name)
          },
        },
      })),
    })
  }

  if (palette.length > 0) {
    groups.push({
      id: 'commands',
      heading: '命令',
      rows: palette.map((entry) => ({
        id: entry.name,
        icon: <TerminalIcon aria-hidden="true" />,
        label: entry.label,
        ...(entry.description === '' ? {} : { detail: entry.description }),
        token: entry.label,
        action: { kind: 'insert' as const, snippet: entry.label },
      })),
    })
  }

  return groups
}

/*
 * 批准方式之外的生效模式。
 *
 * manual / yolo / auto 由 PermissionPicker 常显（plan 期间显示挂起的那一档）；
 * 这里只显示 Plan 等额外模式。mode 与批准方式共用同一个控制值：进 plan 会把批准
 * 方式覆写掉，摘掉时把挂起前那一档还回去（记忆归 posture-memory.ts），不是退回首档。
 */
export interface ComposerModeChipProps {
  readonly controls: readonly SessionConfigControl[]
  readonly onSelect: (controlId: string, value: string) => void
}

/** 一枚生效档位：静息左图标右文字，悬停换成移除圆钮。 */
function chip(id: string, glyph: ReactNode, label: string, exit: () => void): ReactNode {
  return (
    <button
      aria-label={`退出${label}`}
      className="assistant-mode-chip"
      key={id}
      onClick={exit}
      type="button"
    >
      <span aria-hidden="true" className="assistant-mode-chip__icon">
        <span className="assistant-mode-chip__glyph">{glyph}</span>

        <span className="assistant-mode-chip__remove">
          <CloseIcon />
        </span>
      </span>

      <span className="assistant-mode-chip__label">{label}</span>
    </button>
  )
}

/*
 * 生效中的模式，一排胶囊。真相在 agent：摘掉时把挂起前的批准方式还回去
 * （记忆归 posture-memory.ts）。
 */
export function ComposerModeChip({ controls, onSelect }: ComposerModeChipProps) {
  const mode = controls.find((control) => control.purpose === 'mode')
  const rememberedPosture = usePostureMemory(controls)
  const chips: ReactNode[] = []

  if (mode !== undefined && permissionPostureOf(mode.current) === undefined) {
    const [first] = mode.choices
    const inForce = mode.choices.find((choice) => choice.value === mode.current)

    if (first !== undefined && inForce !== undefined && mode.current !== first.value) {
      const firstPosture = mode.choices.find(
        (choice) => permissionPostureOf(choice.value) !== undefined,
      )

      chips.push(
        chip(mode.id, <SirenIcon />, inForce.label, () => {
          onSelect(mode.id, rememberedPosture ?? firstPosture?.value ?? first.value)
        }),
      )
    }
  }

  if (chips.length === 0) {
    return null
  }

  return (
    <>
      <span aria-hidden="true" className="assistant-mode-chip__divider" />

      {chips}
    </>
  )
}
