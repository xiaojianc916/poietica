import type { RunMode, RunModeName } from '@poietica/agent'
import { permissionPostureOf } from '@poietica/agent'
import type { AgentSkill, PaletteEntry, SessionConfigControl } from '@poietica/agent-contract'
import type { ReactNode } from 'react'
import {
  CloseIcon,
  GoalIcon,
  PlusIcon,
  SirenIcon,
  SkillIcon,
  SwarmIcon,
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
 * 这里只剩下扳机和一次投影。
 *
 * 「添加」组里跟在「添加文件」后面的行（生效模式，目前是 Plan）由这里投影；
 * other 选择器仍各立一组。批准方式由 PermissionPicker 独占，不能再把
 * Auto / YOLO 作为第二套入口重复显示。
 */

export function ComposerActions() {
  const { togglePalette } = usePromptInputActions()

  return (
    <button aria-label="添加内容" className="assistant-plus" onClick={togglePalette} type="button">
      <PlusIcon aria-hidden="true" />
    </button>
  )
}

/* 这条对话自己的两档模式：一张表，摊成面板里的行与工具栏上的胶囊。 */
const LOCAL_MODES: readonly {
  readonly name: RunModeName
  readonly label: string
  readonly detail: string
  readonly icon: ReactNode
}[] = [
  {
    name: 'goal',
    label: '目标',
    detail: '把这一句当作要持续追求的目标',
    icon: <GoalIcon aria-hidden="true" />,
  },
  {
    name: 'swarm',
    label: '蜂群模式',
    detail: '多个子代理并行协作',
    icon: <SwarmIcon aria-hidden="true" />,
  },
]

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
 * 生效模式摊成行，并进输入框「添加」组，跟在「添加文件」后面。
 *
 * 行而不是组：Mode 不单立分类。agent 报的那几档在前，这条对话自己的两档在后，
 * 一种动作（run）—— 面板因此不需要认识模式。批准方式由 PermissionPicker 独占。
 */
export function composerModeRows({
  controls,
  modes,
  onSelectControl,
  onToggleMode,
}: Pick<ComposerPaletteSource, 'controls' | 'onSelectControl'> & {
  readonly modes: RunMode
  readonly onToggleMode: (mode: RunModeName) => void
}): readonly PaletteRow[] {
  const rows: PaletteRow[] = []

  for (const control of controls) {
    if (control.purpose !== 'mode') {
      continue
    }

    for (const choice of control.choices) {
      if (permissionPostureOf(choice.value) !== undefined) {
        continue
      }

      rows.push(controlRow(control, choice, onSelectControl, <SirenIcon aria-hidden="true" />))
    }
  }

  for (const mode of LOCAL_MODES) {
    rows.push({
      id: `mode:${mode.name}`,
      icon: mode.icon,
      label: mode.label,
      detail: mode.detail,
      checked: modes[mode.name],
      action: {
        kind: 'run',
        run: () => {
          onToggleMode(mode.name)
        },
      },
    })
  }

  return rows
}

/**
 * agent 报的 other 选择器与命令，摊成面板的分组。
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
        token: `/${skill.name}`,
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
  /** 这条对话自己的模式。真相在 TranscriptStore。 */
  readonly modes: RunMode
  readonly onToggleMode: (mode: RunModeName) => void
}

/** 一枚生效档位：静息左图标右文字，悬停换成移除圆钮。三种模式共用这一处。 */
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
 * 生效中的模式，一排胶囊。
 *
 * agent 报的那一档（Plan）真相在 agent，摘掉时把挂起前的批准方式还回去（记忆归
 * posture-memory.ts）；目标与蜂群真相在这条对话（TranscriptStore.modes）。两种
 * 归属，一套画法与一套交互 —— 屏幕上它们是同一种东西，所以只有这一处代码。
 */
export function ComposerModeChip({
  controls,
  modes,
  onSelect,
  onToggleMode,
}: ComposerModeChipProps) {
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

  for (const mode of LOCAL_MODES) {
    if (modes[mode.name]) {
      chips.push(
        chip(mode.name, mode.icon, mode.label, () => {
          onToggleMode(mode.name)
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
