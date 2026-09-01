import type {
  AgentMcpServer,
  AgentSkill,
  PromptConfiguration,
  SessionConfigControl,
} from '@poietica/conversation'
import type { ReactNode } from 'react'
import { isToggleControl } from '../../composer/session-controls'
import { GOAL_CONTROL_ID } from '../goal/goal-control'
import { CloseIcon, GoalIcon, PlusIcon, SirenIcon, SkillIcon, ToolIcon } from '../primitives/icons'
import type { PaletteGroup, PaletteRow } from './composer-palette'
import type { PromptChipValue } from './prompt-chip'
import { usePromptInputActions, usePromptInputDraft, usePromptInputPalette } from './prompt-input'

/* 扳机自报开合（WAI-ARIA disclosure），皮肤读的就是这一格：真相只有输入框那一份。 */
export function ComposerActions() {
  const { togglePalette } = usePromptInputActions()
  const palette = usePromptInputPalette()
  return (
    <button
      aria-controls={palette?.listboxId}
      aria-expanded={palette?.expanded ?? false}
      aria-label="添加内容"
      className="assistant-plus"
      onClick={togglePalette}
      type="button"
    >
      <PlusIcon aria-hidden="true" />
    </button>
  )
}

/* 目标控制身份由 goal/goal-control.ts 单点定义。 */

export interface ComposerPaletteSource {
  readonly controls: readonly SessionConfigControl[]
  readonly onSelectControl: (controlId: string, value: string, input?: string) => void
  readonly skills: readonly AgentSkill[]
  readonly mcpServers: readonly AgentMcpServer[]
}

function insertRow(
  id: string,
  label: string,
  detail: string | undefined,
  icon: ReactNode,
  chip: PromptChipValue,
): PaletteRow {
  return {
    id,
    icon,
    label,
    ...(detail === undefined || detail === '' ? {} : { detail }),
    action: { kind: 'insert', chip },
  }
}

export function activePromptConfiguration(
  controls: readonly SessionConfigControl[],
): readonly PromptConfiguration[] {
  return controls
    .filter(
      (control) =>
        control.appliesOnSubmit !== true && isToggleControl(control) && control.current === 'on',
    )
    .map((control) => ({ id: control.id, value: control.current }))
}

function toggleRow(
  control: SessionConfigControl,
  onSelect: ComposerPaletteSource['onSelectControl'],
): PaletteRow {
  const enabled = control.current === 'on'
  const choice = control.choices.find((candidate) => candidate.value === 'on')
  const Icon = control.id === GOAL_CONTROL_ID ? GoalIcon : SirenIcon
  return {
    id: control.id,
    icon: <Icon aria-hidden="true" />,
    label: control.label,
    ...(choice?.detail === undefined ? {} : { detail: choice.detail }),
    checked: enabled,
    action:
      !enabled && control.appliesOnSubmit === true
        ? {
            kind: 'configure',
            configuration: { id: control.id, value: 'on' },
            label: control.label,
          }
        : {
            kind: 'run',
            run: () => {
              onSelect(control.id, enabled ? 'off' : 'on')
            },
          },
  }
}

function choiceRow(
  control: SessionConfigControl,
  choice: SessionConfigControl['choices'][number],
  onSelect: ComposerPaletteSource['onSelectControl'],
): PaletteRow {
  return {
    id: `${control.id}:${choice.value}`,

    icon: <ToolIcon aria-hidden="true" />,
    label: choice.label,
    ...(choice.detail === undefined ? {} : { detail: choice.detail }),
    checked: choice.value === control.current,
    action: {
      kind: 'run',
      run: () => {
        if (choice.value !== control.current) {
          onSelect(control.id, choice.value)
        }
      },
    },
  }
}

/* 状态说人话：连没连上与有几个工具是两格话，不让人从数字反推状态。 */
function mcpDetail(server: AgentMcpServer): string {
  switch (server.status) {
    case 'connected':
      return server.toolCount === 0 ? '已连接 · 暂无工具' : `已连接 · ${server.toolCount} 个工具`
    case 'connecting':
      return '连接中'
    case 'disconnected':
      return '未连接'
    case 'error':
      return server.lastError === undefined ? '起不来' : `起不来：${server.lastError}`
  }
}

export function composerPaletteGroups({
  controls,
  mcpServers,
  onSelectControl,
  skills,
}: ComposerPaletteSource): readonly PaletteGroup[] {
  const groups: PaletteGroup[] = []
  const modes = controls
    .filter((control) => control.purpose === 'mode')
    .map((control) => toggleRow(control, onSelectControl))
  if (modes.length > 0) {
    groups.push({ id: 'modes', heading: '模式', rows: modes })
  }

  for (const control of controls) {
    if (control.purpose !== 'other' || control.choices.length === 0 || isToggleControl(control)) {
      continue
    }
    groups.push({
      id: control.id,
      heading: control.label,
      rows: control.choices.map((choice) => choiceRow(control, choice, onSelectControl)),
    })
  }

  if (skills.length > 0) {
    groups.push({
      id: 'skills',
      heading: '技能',
      rows: skills.map((skill) =>
        insertRow(
          `skill:${skill.name}`,
          skill.name,
          skill.description,
          <SkillIcon aria-hidden="true" />,
          { kind: 'skill', name: skill.name },
        ),
      ),
    })
  }

  if (mcpServers.length > 0) {
    groups.push({
      id: 'mcp',
      heading: 'MCP',
      rows: mcpServers.map((server) =>
        insertRow(
          `mcp:${server.id}`,
          server.name,
          mcpDetail(server),
          <ToolIcon aria-hidden="true" />,
          { kind: 'mcp', id: server.id, name: server.name },
        ),
      ),
    })
  }
  return groups
}

export interface ComposerChipsProps {
  readonly controls: readonly SessionConfigControl[]
  readonly onSelect: (controlId: string, value: string) => void
}

function glyph(controlId: string): ReactNode {
  return controlId === GOAL_CONTROL_ID ? <GoalIcon /> : <SirenIcon />
}

/* 一枚标记就是它的摘除键：静息画模式字形，悬停换成叉。 */
function ModeChip({
  controlId,
  label,
  onRemove,
  removeLabel,
}: {
  readonly controlId: string
  readonly label: string
  readonly onRemove: () => void
  readonly removeLabel: string
}) {
  return (
    <button
      aria-label={removeLabel}
      className="assistant-mode-chip"
      onClick={onRemove}
      type="button"
    >
      <span aria-hidden="true" className="assistant-mode-chip__icon">
        <span className="assistant-mode-chip__glyph">{glyph(controlId)}</span>
        <span className="assistant-mode-chip__remove">
          <CloseIcon />
        </span>
      </span>
      <span className="assistant-mode-chip__label">{label}</span>
    </button>
  )
}

export function ComposerChips({ controls, onSelect }: ComposerChipsProps) {
  const { configuration } = usePromptInputDraft()
  const { removeConfiguration } = usePromptInputActions()

  /* 生效中的模式；目标进了模式就归灵动岛，这里不留它。 */
  const active = controls.filter(
    (control) =>
      control.purpose === 'mode' && control.current === 'on' && control.id !== GOAL_CONTROL_ID,
  )

  if (active.length === 0 && configuration.length === 0) {
    return null
  }

  return (
    <>
      <span aria-hidden="true" className="assistant-mode-chip__divider" />

      {active.map((control) => (
        <ModeChip
          controlId={control.id}
          key={control.id}
          label={control.label}
          onRemove={() => onSelect(control.id, 'off')}
          removeLabel={`退出${control.label}`}
        />
      ))}

      {configuration.map((selected) => (
        <ModeChip
          controlId={selected.id}
          key={`pending:${selected.id}`}
          label={selected.label}
          onRemove={() => removeConfiguration(selected.id)}
          removeLabel={`取消${selected.label}`}
        />
      ))}
    </>
  )
}
