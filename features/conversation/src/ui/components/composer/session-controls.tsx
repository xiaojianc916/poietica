import './session-controls.css'

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuRadioItemIndicator,
  DropdownMenuTrigger,
} from '@poietica/design-system'
import { Check, ChevronRight } from 'lucide-react'
import { memo, useMemo, useState } from 'react'
import type { SessionConfigControl } from '../../agent/config'
import { SWARM_CONTROL_ID } from './swarm-toggle'

/*
 * 工具条上一颗胶囊，打开是一张卡，卡里换的是页。值没有第二份：agent 报的那张表就是全部，点了就发一次改动，值由答复换掉 —— 滑轨因此受控。
 * 档位那一行 closeOnClick=false（职责是换页不是提交）；Escape 在清单页先退回根页，再按一次才关闭。
 */

export function isToggleControl(control: SessionConfigControl): boolean {
  const values = new Set(control.choices.map((choice) => choice.value))

  return values.size === 2 && values.has('off') && values.has('on')
}

const LEVEL = 'level'
const MODEL = 'model'

const ORDER: readonly string[] = ['model', 'thought', 'other']

function rank(purpose: SessionConfigControl['purpose']): number {
  const found = ORDER.indexOf(purpose)

  return found < 0 ? ORDER.length : found
}
export function labelOf(control: SessionConfigControl, choice: SessionConfigControl['choices'][number]): string {
  const prefix = `${control.label}`
  const stripped = choice.label.startsWith(prefix) ? choice.label.slice(prefix.length).trimStart() : ''
  const label = stripped.length > 0 ? stripped : choice.label

  return control.purpose === 'thought' ? label.charAt(0).toUpperCase() + label.slice(1) : label
}

/* 候选集里没有生效值时退回原文：空白胶囊说不出此刻在用什么。 */
function chosen(control: SessionConfigControl): string {
  const inForce = control.choices.find((choice) => choice.value === control.current)

  return inForce === undefined ? control.current : labelOf(control, inForce)
}

export function sessionControlRows(controls: readonly SessionConfigControl[]): readonly SessionConfigControl[] {
  return (
    [...controls]
      .filter((control) => ORDER.includes(control.purpose))
      /* Swarm 不住在菜单里（它是上下文栏右端的勾选）：一个控制只有一个住处。 */
      .filter((control) => control.id !== SWARM_CONTROL_ID)
      .sort((left, right) => rank(left.purpose) - rank(right.purpose))
  )
}

/* 轨道两端各留半个滑块，滑块中心、档位点、填充终点是同一条式子，分开算会错位。 */
function stopOffset(position: number, count: number): string {
  const span = count - 1
  const ratio = span > 0 ? position / span : 0

  return `calc(var(--cp-model-thumb) / 2 + ${ratio} * (100% - var(--cp-model-thumb)))`
}

/* 反解 stopOffset（档位点与滑块同一条式子），每帧读一次轨道盒子与滑块宽即可，与档位数无关。 */
function stopAt(rail: HTMLElement, clientX: number, count: number): number {
  const span = count - 1

  if (span < 1) {
    return 0
  }

  const thumb = Number.parseFloat(getComputedStyle(rail).getPropertyValue('--cp-model-thumb'))
  const box = rail.getBoundingClientRect()
  const travel = box.width - thumb

  if (!Number.isFinite(thumb) || travel <= 0) {
    return 0
  }

  const ratio = (clientX - box.left - thumb / 2) / travel

  return Math.max(0, Math.min(span, Math.round(ratio * span)))
}

export interface SessionControlsProps {
  readonly controls: readonly SessionConfigControl[]
  readonly onSelect: (controlId: string, value: string) => void
  /** 这张表还没被 agent 确认过：画法不变，只是点不动。 */
  readonly pending?: boolean | undefined
}

export const SessionControls = memo(function SessionControls({ controls, onSelect, pending }: SessionControlsProps) {
  const rows = useMemo(() => sessionControlRows(controls), [controls])
  const [pane, setPane] = useState<string>(LEVEL)
  const [open, setOpen] = useState(false)

  const level = rows.find((control) => control.purpose === 'thought')
  const model = rows.find((control) => control.purpose === 'model')

  /* 没有控件可画就整个不画：连不上怎么说归 composer-notice 那条提示。 */
  if (level === undefined && model === undefined) {
    return null
  }

  const name = model === undefined ? undefined : chosen(model)
  const band = level === undefined ? undefined : chosen(level)

  const listing = model !== undefined && (level === undefined || pane === MODEL)

  const listPane =
    model === undefined ? null : (
      <div className="assistant-model-select__list-pane">
        <DropdownMenuRadioGroup
          onValueChange={(value) => {
            if (value === model.current) {
              return
            }

            onSelect(model.id, value)
          }}
          value={model.current}
        >
          {model.choices.map((choice) => (
            <DropdownMenuRadioItem
              className="assistant-model-select__item"
              closeOnClick
              key={choice.value}
              value={choice.value}
            >
              <span className="assistant-model-select__item-name">{choice.label}</span>

              <DropdownMenuRadioItemIndicator className="assistant-model-select__item-tick">
                <Check aria-hidden="true" size={14} />
              </DropdownMenuRadioItemIndicator>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </div>
    )

  const bandPane =
    level === undefined ? null : (
      <div className="assistant-model-select__band-pane">
        {/* 点击整页换成模型清单；没有模型控件时它就只是一行字。 */}
        {model === undefined ? (
          <div className="assistant-model-select__head">
            <span className="assistant-model-select__head-band">{band}</span>
          </div>
        ) : (
          <DropdownMenuItem
            className="assistant-model-select__head"
            closeOnClick={false}
            onClick={() => {
              setPane(MODEL)
            }}
          >
            <span className="assistant-model-select__head-band">
              {band}

              <ChevronRight aria-hidden="true" className="assistant-model-select__head-chevron" size={12} />
            </span>

            <span className="assistant-model-select__head-name">{name}</span>
          </DropdownMenuItem>
        )}

        {rail(level, band ?? level.current, onSelect)}
      </div>
    )

  return (
    <DropdownMenu
      onOpenChange={(nextOpen) => {
        /* 未确认时开不动，但外观与平时一样：不靠 disabled，那会连画法一起改掉（DropdownMenuTrigger 自带 disabled:opacity-50）。 */
        if (pending) {
          return
        }

        setOpen(nextOpen)

        if (!nextOpen) {
          setPane(LEVEL)
        }
      }}
      open={open}
    >
      <DropdownMenuTrigger
        aria-busy={pending ? true : undefined}
        aria-disabled={pending ? true : undefined}
        aria-label="模型与思考档位"
        className="assistant-model-select__button"
      >
        {name === undefined ? null : <span className="assistant-model-select__name">{name}</span>}

        {band === undefined ? null : <span className="assistant-model-select__band">{band}</span>}
      </DropdownMenuTrigger>

      <DropdownMenuContent
        align="end"
        className="assistant-model-select__panel assistant-menu-surface"
        data-assistant-skin
        onKeyDown={(event) => {
          if (event.key === 'Escape' && listing) {
            /* 清单页的 Escape 是退回档位页，不是关闭；档位页的 Escape 仍归 Base UI。 */
            event.preventDefault()
            event.stopPropagation()
            setPane(LEVEL)
          }
        }}
        side="top"
        sideOffset={6}
      >
        {listing ? listPane : bandPane}
      </DropdownMenuContent>
    </DropdownMenu>
  )
})

/*
 * 指针全归底轨自己（点一下、按住横拖都走 setPointerCapture 加落点反解）；档位是离散的，一次横拖每跨一格换一次。
 * 方向键必须在输入框上止住：菜单也监听方向键并 preventDefault，放它冒泡上去档位就一动不动。
 */
function rail(control: SessionConfigControl, band: string, onSelect: (controlId: string, value: string) => void) {
  const count = control.choices.length
  const at = Math.max(
    0,
    control.choices.findIndex((choice) => choice.value === control.current),
  )

  /* 同一个值不重发：方向键连按与横拖扫过都会走到这里。 */
  const pick = (position: number) => {
    const next = control.choices[position]

    if (next === undefined || next.value === control.current) {
      return
    }

    onSelect(control.id, next.value)
  }

  return (
    <div
      className="assistant-model-select__rail"
      onPointerDown={(event) => {
        event.currentTarget.setPointerCapture(event.pointerId)
        /* 顺手把焦点交给输入框：点完接着按方向键微调。 */
        event.currentTarget.querySelector('input')?.focus()
        pick(stopAt(event.currentTarget, event.clientX, count))
      }}
      onPointerMove={(event) => {
        /* 捕获在 pointerup 时由浏览器自己放掉，所以这一条同时也是「还在拖」的判据。 */
        if (event.currentTarget.hasPointerCapture(event.pointerId)) {
          pick(stopAt(event.currentTarget, event.clientX, count))
        }
      }}
      style={{ backgroundSize: `${stopOffset(at, count)} 100%` }}
    >
      {control.choices.map((choice, position) => (
        <span
          className="assistant-model-select__dot"
          data-passed={position <= at ? 'true' : 'false'}
          key={choice.value}
          /* 档位点与滑块同一条式子：中心落在行程上，两端各留半个滑块。 */
          style={{ insetInlineStart: stopOffset(position, count) }}
        />
      ))}

      <span className="assistant-model-select__thumb" style={{ insetInlineStart: stopOffset(at, count) }} />

      <input
        aria-label={control.label}
        aria-valuetext={band}
        className="assistant-model-select__input"
        max={count - 1}
        min={0}
        onChange={(event) => {
          pick(Number(event.target.value))
        }}
        onKeyDown={(event) => {
          if (event.key !== 'Escape') {
            event.stopPropagation()
          }
        }}
        step={1}
        type="range"
        value={at}
      />
    </div>
  )
}
