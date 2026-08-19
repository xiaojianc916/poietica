import type { SessionConfigControl } from '@poietica/agent-contract'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuRadioItemIndicator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@poietica/ui'
import { Fragment, memo, useMemo } from 'react'

/*
 * Everything the session lets us change, in one control.
 *
 * 一级列 purpose、二级列取值。一级菜单的行数等于可调维度数，与取值总数解耦，
 * 新增模型不会把菜单撑到屏幕外；当前值在一级行右侧直接可读，不必逐段扫描勾选。
 *
 * 子菜单用设计系统导出的 Base UI Menu.SubmenuRoot：悬停延迟、安全三角、方向键
 * 进出、Escape 逐级关闭、焦点归还都是标准的职责。Portal 由 DropdownMenuSubContent
 * 自己带，与 DropdownMenuContent 对称，调用处不需要知道它存在；portal 之后皮肤属性
 * 必须挂在弹层自身，后代选择器够不到 body 下的节点——这正是此前菜单是裸默认皮肤的
 * 原因。
 */

const UNAVAILABLE = '没连上 agent，点击重试'

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
  const prefix = `${control.label} `
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

/** 入参只有 controls 会变，而这下面是一个菜单根加 N 个子菜单根。 */
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
    <DropdownMenu>
      <DropdownMenuTrigger aria-label="会话设置" className="assistant-model-select__button">
        <span className="assistant-model-select__label">{chosen(model ?? firstRow)}</span>
      </DropdownMenuTrigger>

      <DropdownMenuContent
        align="end"
        className="assistant-config-menu__panel assistant-menu-surface"
        data-assistant-skin
        side="top"
        sideOffset={6}
      >
        {rows.map((control) => (
          <Fragment key={control.id}>
            <DropdownMenuSub>
              <DropdownMenuSubTrigger className="assistant-config-menu__row">
                <span className="assistant-config-menu__row-label">{control.label}</span>

                <span className="assistant-config-menu__row-value">{chosen(control)}</span>
              </DropdownMenuSubTrigger>

              <DropdownMenuSubContent
                align="start"
                className="assistant-config-menu__submenu assistant-menu-surface"
                data-assistant-skin
                side="left"
              >
                <DropdownMenuRadioGroup
                  onValueChange={(value) => {
                    if (value === control.current) {
                      return
                    }

                    onSelect(control.id, value)
                  }}
                  value={control.current}
                >
                  {control.choices.map((choice) => (
                    <DropdownMenuRadioItem
                      className="assistant-config-option"
                      key={choice.value}
                      value={choice.value}
                    >
                      <span className="assistant-config-option__label">
                        {labelOf(control, choice)}
                      </span>

                      {choice.detail === undefined ? null : (
                        <span className="assistant-config-option__detail">{choice.detail}</span>
                      )}

                      <DropdownMenuRadioItemIndicator className="assistant-config-option__indicator" />
                    </DropdownMenuRadioItem>
                  ))}
                </DropdownMenuRadioGroup>
              </DropdownMenuSubContent>
            </DropdownMenuSub>

            {showUnavailableThinking && control.purpose === 'model' ? (
              <DropdownMenuItem className="assistant-config-menu__row" disabled>
                <span className="assistant-config-menu__row-label">Thinking</span>
                <span className="assistant-config-menu__row-value">no</span>
              </DropdownMenuItem>
            ) : null}
          </Fragment>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
})
