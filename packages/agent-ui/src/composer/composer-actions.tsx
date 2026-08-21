import { permissionPostureOf } from '@poietica/agent'
import type { PaletteEntry, SessionConfigControl } from '@poietica/agent-contract'
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

export interface ComposerPaletteSource {
  readonly controls: readonly SessionConfigControl[]
  readonly onSelectControl: (controlId: string, value: string) => void
  /** agent 报的命令表；技能与命令两组由它长出，与斜杠触发读同一张。 */
  readonly palette: readonly PaletteEntry[]
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
 * 生效模式（目前是 Plan）摊成行，并进输入框「添加」组，跟在「添加文件」后面。
 *
 * 行而不是组：Mode 不单立分类。批准方式由 PermissionPicker 独占，这里仍然滤掉。
 */
export function composerModeRows({
  controls,
  onSelectControl,
}: Pick<ComposerPaletteSource, 'controls' | 'onSelectControl'>): readonly PaletteRow[] {
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

  return rows
}

/**
 * agent 报的 other 选择器与命令，摊成面板的分组。
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
    /* 技能是这一句的调用式，交给输入框成为一枚胶囊；命令仍是插进正文的一段字。 */
    action: skill
      ? { kind: 'skill', skill: { call: entry.label, title: entry.title } }
      : { kind: 'insert', snippet: entry.label },
  }
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

export function ComposerModeChip({ controls, onSelect }: ComposerModeChipProps) {
  const mode = controls.find((control) => control.purpose === 'mode')
  const rememberedPosture = usePostureMemory(controls)

  if (mode === undefined || permissionPostureOf(mode.current) !== undefined) {
    return null
  }

  const [first] = mode.choices
  const inForce = mode.choices.find((choice) => choice.value === mode.current)

  if (first === undefined || inForce === undefined || mode.current === first.value) {
    return null
  }

  /* 没有记忆（会话一进来就是 plan）才落回首档批准方式。 */
  const firstPosture = mode.choices.find(
    (choice) => permissionPostureOf(choice.value) !== undefined,
  )

  return (
    <>
      <span aria-hidden="true" className="assistant-mode-chip__divider" />

      <button
        aria-label={`退出${inForce.label}`}
        className="assistant-mode-chip"
        onClick={() => {
          onSelect(mode.id, rememberedPosture ?? firstPosture?.value ?? first.value)
        }}
        type="button"
      >
        <span aria-hidden="true" className="assistant-mode-chip__icon">
          <SirenIcon className="assistant-mode-chip__glyph" />

          <span className="assistant-mode-chip__remove">
            <CloseIcon />
          </span>
        </span>

        <span className="assistant-mode-chip__label">{inForce.label}</span>
      </button>
    </>
  )
}
