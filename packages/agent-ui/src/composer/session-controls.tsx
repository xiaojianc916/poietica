import type { SessionConfigControl } from '@poietica/agent-contract'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuRadioItemIndicator,
  DropdownMenuTrigger,
} from '@poietica/ui'
import { Fragment, memo, useMemo, useState } from 'react'

/*
 * Everything the session lets us change, in one control.
 *
 * 单层弹窗、面板内换页：根页是每个可调维度一行（标签 + 当前值），点行把同一张
 * 弹层整页切换成该维度的取值列表 —— 与 deepseek-harness ModelSelect 的 root / model
 * / effort 同一个范式，不再使用悬停展开的级联子菜单。
 *
 * 弹层始终只有一张：面板的尺寸、边框、圆角、阴影与定位沿用既有类名与参数，换页
 * 不换壳。根行用 closeOnClick=false，因为那一行的职责是换页而不是提交；取值行显式
 * closeOnClick —— 点选即提交，提交即关闭，一次选择就是一个完成的任务。（Base UI
 * 的 Menu.RadioItem 默认 closeOnClick=false，不显式写出来弹层不会关。）Escape 在
 * 取值页先退回根页，再按一次才关闭；菜单关闭时页签复位，下次打开永远从根页开始。
 *
 * Portal 与皮肤属性的职责不变：DropdownMenuContent 自带 portal，data-assistant-skin
 * 挂在弹层自身。
 */

const UNAVAILABLE = '没连上 agent，点击重试'

const ROOT = 'root'

const ORDER: readonly string[] = ['model', 'thought', 'other']

/** Where a purpose sits; anything unrecognised sorts last rather than away. */
function rank(purpose: SessionConfigControl['purpose']): number {
  const found = ORDER.indexOf(purpose)

  return found < 0 ? ORDER.length : found
}

function labelOf(
  control: SessionConfigControl,
  choice: SessionConfigControl['choices'][number],
): string {
  const prefix = control.label + ' '
  const stripped = choice.label.startsWith(prefix) ? choice.label.slice(prefix.length) : ''

  return stripped.length > 0 ? stripped : choice.label
}

/* `current ∈ choices` is enforced at the native adapter boundary. */
function chosen(control: SessionConfigControl): string | undefined {
  const inForce = control.choices.find((choice) => choice.value === control.current)

  return inForce === undefined ? undefined : labelOf(control, inForce)
}

/**
 * A model row without a Thought control means the exact model declares no
 * Thinking capability. The UI states that fact instead of inventing a choice.
 */
export function hasUnavailableThinking(controls: readonly SessionConfigControl[]): boolean {
  return (
    controls.some((control) => control.purpose === 'model') &&
    controls.every((control) => control.purpose !== 'thought')
  )
}

export interface SessionControlsProps {
  readonly controls: readonly SessionConfigControl[]
  readonly failure?: string | undefined
  readonly onSelect: (controlId: string, value: string) => void
  /** 失败之后再打开一次；没有这个，失败就是一条死路。 */
  readonly onRetry?: (() => void) | undefined
}

/** 入参只有 controls 会变，而这下面只有一张弹层加一个页签状态。 */
export const SessionControls = memo(function SessionControls({
  controls,
  failure,
  onRetry,
  onSelect,
}: SessionControlsProps) {
  const rows = useMemo(
    () =>
      [...controls]
        .filter((control) => control.purpose !== 'mode')
        .sort((left, right) => rank(left.purpose) - rank(right.purpose)),
    [controls],
  )

  const model = useMemo(() => controls.find((control) => control.purpose === 'model'), [controls])
  const showUnavailableThinking = hasUnavailableThinking(rows)
  const [pane, setPane] = useState<string>(ROOT)
  const drilled = rows.find((control) => control.id === pane)
  const [firstRow] = rows

  if (firstRow === undefined) {
    if (failure === undefined) {
      return null
    }

    return (
      <button
        aria-live="polite"
        className="assistant-model-select__button"
        data-empty="true"
        data-failed="true"
        onClick={onRetry}
        title={failure}
        type="button"
      >
        <span className="assistant-model-select__label">{UNAVAILABLE}</span>
      </button>
    )
  }

  return (
    <DropdownMenu
      onOpenChange={(open) => {
        if (!open) {
          setPane(ROOT)
        }
      }}
    >
      <DropdownMenuTrigger aria-label="会话设置" className="assistant-model-select__button">
        <span className="assistant-model-select__label">{chosen(model ?? firstRow)}</span>
      </DropdownMenuTrigger>

      <DropdownMenuContent
        align="end"
        className="assistant-config-menu__panel assistant-menu-surface"
        data-assistant-skin
        onKeyDown={(event) => {
          if (event.key === 'Escape' && drilled !== undefined) {
            /* 取值页的 Escape 是退回根页，不是关闭；根页的 Escape 仍归 Base UI。 */
            event.preventDefault()
            event.stopPropagation()
            setPane(ROOT)
          }
        }}
        side="top"
        sideOffset={6}
      >
        {drilled === undefined ? (
          rows.map((control) => (
            <Fragment key={control.id}>
              <DropdownMenuItem
                className="assistant-config-menu__row"
                closeOnClick={false}
                onClick={() => {
                  setPane(control.id)
                }}
              >
                <span className="assistant-config-menu__row-label">{control.label}</span>

                <span className="assistant-config-menu__row-value">{chosen(control)}</span>
              </DropdownMenuItem>

              {showUnavailableThinking && control.purpose === 'model' ? (
                <DropdownMenuItem className="assistant-config-menu__row" disabled>
                  <span className="assistant-config-menu__row-label">Thinking</span>
                  <span className="assistant-config-menu__row-value">no</span>
                </DropdownMenuItem>
              ) : null}
            </Fragment>
          ))
        ) : (
          <DropdownMenuRadioGroup
            onValueChange={(value) => {
              if (value === drilled.current) {
                return
              }

              onSelect(drilled.id, value)
            }}
            value={drilled.current}
          >
            {drilled.choices.map((choice) => (
              <DropdownMenuRadioItem
                className="assistant-config-option"
                closeOnClick
                key={choice.value}
                value={choice.value}
              >
                <span className="assistant-config-option__label">{labelOf(drilled, choice)}</span>

                {choice.detail === undefined ? null : (
                  <span className="assistant-config-option__detail">{choice.detail}</span>
                )}

                <DropdownMenuRadioItemIndicator className="assistant-config-option__indicator" />
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
})
