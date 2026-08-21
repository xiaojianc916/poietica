import type { AgentMcpServer, AgentSkill, SessionConfigControl } from '@poietica/agent-contract'
import type { ReactNode } from 'react'
import {
  CloseIcon,
  GoalIcon,
  PlusIcon,
  SirenIcon,
  SkillIcon,
  SwarmIcon,
  ToolIcon,
} from '../primitives/icons'
import type { PaletteGroup, PaletteRow } from './composer-palette'
import type { PromptChipValue } from './prompt-chip'
import { usePromptInputActions } from './prompt-input'

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

function toggleRow(
  control: SessionConfigControl,
  onSelect: ComposerPaletteSource['onSelectControl'],
): PaletteRow {
  const enabled = control.current === 'on'
  const choice = control.choices.find((candidate) => candidate.value === 'on')
  const Icon = control.id === 'goal' ? GoalIcon : control.id === 'swarm' ? SwarmIcon : SirenIcon
  return {
    id: control.id,
    icon: <Icon aria-hidden="true" />,
    label: control.label,
    ...(choice?.detail === undefined ? {} : { detail: choice.detail }),
    checked: enabled,
    action: {
      kind: 'run',
      run: (draft) => {
        onSelect(control.id, enabled ? 'off' : 'on', control.id === 'goal' ? draft : undefined)
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
    if (control.purpose !== 'other' || control.choices.length === 0) {
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

  const connected = mcpServers.filter((server) => server.status === 'connected')
  if (connected.length > 0) {
    groups.push({
      id: 'mcp',
      heading: '检测到可用的 MCP',
      rows: connected.map((server) =>
        insertRow(
          `mcp:${server.id}`,
          server.name,
          `${server.transport} ${String(server.toolCount)} 个工具`,
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
  readonly swarm?: number | undefined
}

function glyph(controlId: string): ReactNode {
  if (controlId === 'goal') {
    return <GoalIcon />
  }
  if (controlId === 'swarm') {
    return <SwarmIcon />
  }
  return <SirenIcon />
}

function label(control: SessionConfigControl, swarm: number | undefined): string {
  if (control.id === 'goal' && control.detail) {
    return `目标：${control.detail}`
  }
  if (control.id === 'swarm' && swarm !== undefined && swarm > 0) {
    return `蜂群 · ${String(swarm)}`
  }
  return control.label
}

export function ComposerChips({ controls, onSelect, swarm }: ComposerChipsProps) {
  const active = controls.filter(
    (control) => control.purpose === 'mode' && control.current === 'on',
  )
  if (active.length === 0) {
    return null
  }
  return (
    <>
      <span aria-hidden="true" className="assistant-mode-chip__divider" />
      {active.map((control) => {
        const text = label(control, swarm)
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
    </>
  )
}
