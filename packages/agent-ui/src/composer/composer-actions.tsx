import { permissionPostureOf } from '@poietica/agent'
import type { AgentSkill, SessionConfigControl } from '@poietica/agent-contract'
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
 * 面板归输入框（锚在卡的上沿，与斜杠触发同一张，键盘只有一套）。这里只有扳机与
 * 一次投影：模式、技能、命令、other 选择器各立一组。批准方式由 PermissionPicker
 * 独占，不在这张表里出现第二次。
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
  /** 这条会话能用的技能，由 kap 报。 */
  readonly skills: readonly AgentSkill[]
  /** 激活一条技能：一次协议动作，args 由斜杠那一行给。 */
  readonly onActivateSkill: (name: string, args: string) => void
}

/*
 * kap 报的技能分类（GET /sessions/{id}/skills 的 source）。内置那一档就是斜杠命令，
 * 其余按来源分组；顺序即面板顺序，认不出的来源归到最后那一组。
 */
const SKILL_GROUPS: readonly {
  readonly source: string
  readonly heading: string
  readonly icon: ReactNode
  readonly bare: boolean
}[] = [
  { source: 'builtin', heading: '命令', icon: <TerminalIcon aria-hidden="true" />, bare: true },
  { source: 'project', heading: '项目技能', icon: <SkillIcon aria-hidden="true" />, bare: false },
  { source: 'user', heading: '我的技能', icon: <SkillIcon aria-hidden="true" />, bare: false },
  { source: 'extra', heading: '扩展技能', icon: <SkillIcon aria-hidden="true" />, bare: false },
]

/* 面板里的一条：敲下去就是 kap 的 :activate，args 由斜杠那一行给。 */
function skillRow(
  skill: AgentSkill,
  icon: PaletteRow['icon'],
  bare: boolean,
  onActivateSkill: (name: string, args: string) => void,
): PaletteRow {
  const token = bare ? `/${skill.name}` : `/skill:${skill.name}`

  return {
    id: `skill:${skill.name}`,
    icon,
    label: bare ? token : skill.name,
    ...(skill.description === '' ? {} : { detail: skill.description }),
    token,
    action: {
      kind: 'run',
      run: (args: string) => {
        onActivateSkill(skill.name, args)
      },
    },
  }
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

  for (const group of SKILL_GROUPS) {
    const listed = skills.filter((skill) => skill.source === group.source)

    if (listed.length > 0) {
      groups.push({
        id: `skills:${group.source}`,
        heading: group.heading,
        rows: listed.map((skill) => skillRow(skill, group.icon, group.bare, onActivateSkill)),
      })
    }
  }

  /* kap 报了一个这张表没列的来源：仍然要敲得出来。 */
  const rest = skills.filter(
    (skill) => !SKILL_GROUPS.some((group) => group.source === skill.source),
  )

  if (rest.length > 0) {
    groups.push({
      id: 'skills',
      heading: '技能',
      rows: rest.map((skill) =>
        skillRow(skill, <SkillIcon aria-hidden="true" />, false, onActivateSkill),
      ),
    })
  }

  return groups
}

/*
 * 输入框上沿那排胶囊：这一句将在什么处境下被执行。
 *
 * 模式的真相在 agent 的 mode 选择器，所以它可摘 —— 摘掉时把挂起前那一档批准方式
 * 还回去（记忆归 posture-memory.ts）。目标与蜂群的真相在转录：kap 把它们报成
 * goal_start 与 agent_call / task 三档工具显示，协议没有给客户端关掉它们的动作，
 * 所以那两枚只读。
 */
export interface ComposerChipsProps {
  readonly controls: readonly SessionConfigControl[]
  readonly onSelect: (controlId: string, value: string) => void
  /** 这一段在进行的那个目标。 */
  readonly goal?: string | undefined
  /** 此刻还在跑的子代理数。 */
  readonly swarm?: number | undefined
}

/** 可摘的那一枚：静息左图标右文字，悬停换成移除圆钮。 */
function exitChip(id: string, glyph: ReactNode, label: string, exit: () => void): ReactNode {
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

/** 只读的那一枚：状态的镜子，不是控件，所以不上手型也不换字形。 */
function stateChip(id: string, glyph: ReactNode, label: string): ReactNode {
  return (
    <span className="assistant-mode-chip assistant-mode-chip--state" key={id} title={label}>
      <span aria-hidden="true" className="assistant-mode-chip__icon">
        <span className="assistant-mode-chip__glyph">{glyph}</span>
      </span>

      <span className="assistant-mode-chip__label">{label}</span>
    </span>
  )
}

export function ComposerChips({ controls, goal, onSelect, swarm }: ComposerChipsProps) {
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
        exitChip(mode.id, <SirenIcon />, inForce.label, () => {
          onSelect(mode.id, rememberedPosture ?? firstPosture?.value ?? first.value)
        }),
      )
    }
  }

  if (goal !== undefined && goal !== '') {
    chips.push(stateChip('goal', <GoalIcon />, goal))
  }

  if (swarm !== undefined && swarm > 0) {
    chips.push(stateChip('swarm', <SwarmIcon />, `${String(swarm)} 个子代理在跑`))
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
