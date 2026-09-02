import '@poietica/composer/actions.css'
import { isToggleControl, PermissionPicker, SessionControls } from '@poietica/composer'

import type { SessionConfigControl } from '@poietica/conversation'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Switch,
} from '@poietica/design-system'
import { Plus, Siren, X } from 'lucide-react'
import { useMemo } from 'react'

export interface AutomationSessionConfigProps {
  readonly controls: readonly SessionConfigControl[]
  readonly onChange: (controlId: string, value: string) => void
  readonly value: Readonly<Record<string, string>>
}

function project(
  controls: readonly SessionConfigControl[],
  value: Readonly<Record<string, string>>,
): readonly SessionConfigControl[] {
  return controls.map((control) => {
    const current = value[control.id] ?? control.current
    const known = control.choices.some((choice) => choice.value === current)

    if (current === control.current && known) {
      return control
    }

    return {
      ...control,
      current,
      choices: known
        ? control.choices
        : [...control.choices, { value: current, label: `${current}（agent 未提供）` }],
    }
  })
}

function ModeMenu({
  controls,
  onChange,
}: {
  readonly controls: readonly SessionConfigControl[]
  readonly onChange: (controlId: string, value: string) => void
}) {
  if (controls.length === 0) {
    return null
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger aria-label="自动化模式" className="assistant-plus">
        <Plus aria-hidden="true" />
      </DropdownMenuTrigger>

      <DropdownMenuContent
        align="start"
        className="assistant-config-menu__panel assistant-menu-surface"
        data-assistant-skin
        side="top"
        sideOffset={6}
      >
        {controls.map((control) => {
          const enabled = control.current === 'on'

          return (
            <DropdownMenuItem
              aria-checked={enabled}
              className="assistant-config-menu__row"
              closeOnClick={false}
              key={control.id}
              onClick={() => {
                onChange(control.id, enabled ? 'off' : 'on')
              }}
              role="menuitemcheckbox"
            >
              <span className="assistant-config-menu__row-label">{control.label}</span>
              <Switch
                aria-hidden="true"
                checked={enabled}
                className="pointer-events-none ml-auto"
                size="sm"
                tabIndex={-1}
              />
            </DropdownMenuItem>
          )
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function ModeChips({
  controls,
  onChange,
}: {
  readonly controls: readonly SessionConfigControl[]
  readonly onChange: (controlId: string, value: string) => void
}) {
  const active = controls.filter((control) => control.current === 'on')
  if (active.length === 0) {
    return null
  }

  return (
    <>
      <span aria-hidden="true" className="assistant-mode-chip__divider" />
      {active.map((control) => (
        <button
          aria-label={`退出${control.label}`}
          className="assistant-mode-chip"
          key={control.id}
          onClick={() => {
            onChange(control.id, 'off')
          }}
          type="button"
        >
          <span aria-hidden="true" className="assistant-mode-chip__icon">
            <span className="assistant-mode-chip__glyph">
              <Siren />
            </span>
            <span className="assistant-mode-chip__remove">
              <X />
            </span>
          </span>
          <span className="assistant-mode-chip__label">{control.label}</span>
        </button>
      ))}
    </>
  )
}

export function AutomationSessionConfig({
  controls,
  onChange,
  value,
}: AutomationSessionConfigProps) {
  const projected = useMemo(() => project(controls, value), [controls, value])
  const modes = useMemo(
    () => projected.filter((control) => control.purpose === 'mode' && isToggleControl(control)),
    [projected],
  )

  if (projected.length === 0) {
    return (
      <p className="px-1.5 py-1 text-xs text-muted-foreground">还没有拿到 agent 报的可选项。</p>
    )
  }

  return (
    <>
      <ModeMenu controls={modes} onChange={onChange} />
      <PermissionPicker controls={projected} onSelect={onChange} />
      <ModeChips controls={modes} onChange={onChange} />
      <span className="assistant-toolbar__spacer" />
      <SessionControls controls={projected} onSelect={onChange} />
    </>
  )
}
