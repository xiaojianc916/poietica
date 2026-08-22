import type {
  AgentMcpServer,
  PromptConfiguration,
  SessionConfigControl,
} from '@poietica/agent-contract'
import type { ReactNode } from 'react'
import { CloseIcon, GoalIcon, PlusIcon, SirenIcon, SkillIcon, ToolIcon } from '../primitives/icons'
import type { PaletteGroup, PaletteRow } from './composer-palette'
import type { PromptChipValue } from './prompt-chip'
import { usePromptInputActions, usePromptInputDraft } from './prompt-input'

export function ComposerActions() {
  const { togglePalette } = usePromptInputActions()
  return (
    <button aria-label="添加内容" className="assistant-plus" onClick={togglePalette} type="button">
      <PlusIcon aria-hidden="true" />
    </button>
  )
}

/** 输入面板只需要技能的调用名、显示名与说明，不接触它来自哪条协议。 */
export interface ComposerSkill {
  readonly name: string
  readonly label?: string | undefined
  readonly description: string
}

export interface ComposerPaletteSource {
  readonly controls: readonly SessionConfigControl[]
  readonly onSelectControl: (controlId: string, value: string, input?: string) => void
  readonly skills: readonly ComposerSkill[]
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

export function isToggleControl(control: SessionConfigControl): boolean {
  const values = new Set(control.choices.map((choice) => choice.value))
  return values.size === 2 && values.has('off') && values.has('on')
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
  const Icon = control.id === 'goal' ? GoalIcon : SirenIcon
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

function mcpStatus(server: AgentMcpServer): string | undefined {
  switch (server.status) {
    case 'connected':
      return undefined
    case 'connecting':
      return '连接中'
    case 'disconnected':
      return '未连接'
    case 'error':
      return '连接失败'
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
          skill.label ?? skill.name,
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
          mcpStatus(server),
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
  return controlId === 'goal' ? <GoalIcon /> : <SirenIcon />
}

function label(control: SessionConfigControl): string {
  return control.id === 'goal' && control.detail ? `目标：${control.detail}` : control.label
}

export function ComposerChips({ controls, onSelect }: ComposerChipsProps) {
  const { configuration } = usePromptInputDraft()
  const { removeConfiguration } = usePromptInputActions()
  const active = controls.filter(
    (control) => control.purpose === 'mode' && control.current === 'on',
  )
  if (active.length === 0 && configuration.length === 0) {
    return null
  }
  return (
    <>
      <span aria-hidden="true" className="assistant-mode-chip__divider" />
      {active.map((control) => {
        const text = label(control)
        return (
          <button
            aria-label={`退出 ${text}`}
            className="assistant-mode-chip"
            key={control.id}
            onClick={() => onSelect(control.id, 'off')}
            type="button"
          >
            <span aria-hidden="true" className="assistant-mode-chip__icon">
              <span className="assistant-mode-chip__glyph">{glyph(control.id)}</span>
              <span className="assistant-mode-chip__remove">
                <CloseIcon />
              </span>
            </span>
            <span className="assistant-mode-chip__label">{text}</span>
          </button>
        )
      })}
      {configuration.map((selected) => (
        <button
          aria-label={`取消 ${selected.label}`}
          className="assistant-mode-chip"
          key={`pending:${selected.id}`}
          onClick={() => removeConfiguration(selected.id)}
          type="button"
        >
          <span aria-hidden="true" className="assistant-mode-chip__icon">
            <span className="assistant-mode-chip__glyph">{glyph(selected.id)}</span>
            <span className="assistant-mode-chip__remove">
              <CloseIcon />
            </span>
          </span>
          <span className="assistant-mode-chip__label">{selected.label}</span>
        </button>
      ))}
    </>
  )
}
