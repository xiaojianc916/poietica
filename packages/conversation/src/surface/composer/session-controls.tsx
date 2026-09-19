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
 * 这条会话的模型与思考档位：工具条上一颗胶囊，打开是一张卡。
 *
 * 屏幕上的值没有第二份。agent 报的那张表就是全部（control.current），点一下是
 * 往它发一次改动，值由它的答复换掉 —— 滑轨因此受控，卡里不存档位。
 *
 * 卡只有一张，换的是卡里的页：根页是档位（蓝字档位名 + 模型名两行居中，下面
 * 一条离散轨道），点档位那一行整页换成模型清单 —— 与 deepseek-harness
 * ModelSelect 的 root / model 同一个范式，不再使用悬停展开的级联子菜单。档位
 * 那一行用 closeOnClick=false，因为它的职责是换页而不是提交；清单里的取值行显式
 * closeOnClick，点选即提交、提交即关闭。（Base UI 的 Menu.RadioItem 默认
 * closeOnClick=false，不显式写出来弹层不会关。）Escape 在清单页先退回根页，再按
 * 一次才关闭；菜单关闭时页签复位，下次打开永远从档位页开始。
 *
 * 这里只住得下 model 与 thought 两类：批准方式是工具条上常显的胶囊
 * （permission-picker），计划、目标与 Swarm 各有各的住处（composer-actions 的
 * 徽记与 swarm-toggle 的勾选）。sessionControlRows 仍然把 other 一并收进来，
 * 只是今天没有第二位 other —— 多出来的一位会在卡里没有位置。
 *
 * Portal 与皮肤属性的职责不变：DropdownMenuContent 自带 portal，data-assistant-skin
 * 挂在弹层自身。
 */

export function isToggleControl(control: SessionConfigControl): boolean {
  const values = new Set(control.choices.map((choice) => choice.value))

  return values.size === 2 && values.has('off') && values.has('on')
}

const LEVEL = 'level'
const MODEL = 'model'

const ORDER: readonly string[] = ['model', 'thought', 'other']

/** Where a purpose sits; anything unrecognised sorts last rather than away. */
function rank(purpose: SessionConfigControl['purpose']): number {
  const found = ORDER.indexOf(purpose)

  return found < 0 ? ORDER.length : found
}

export function labelOf(
  control: SessionConfigControl,
  choice: SessionConfigControl['choices'][number],
): string {
  const prefix = `${control.label}`
  const stripped = choice.label.startsWith(prefix)
    ? choice.label.slice(prefix.length).trimStart()
    : ''
  const label = stripped.length > 0 ? stripped : choice.label

  return control.purpose === 'thought' ? label.charAt(0).toUpperCase() + label.slice(1) : label
}

/* 候选集里没有生效值时退回原文：一颗空白的胶囊说不出此刻在用什么。 */
function chosen(control: SessionConfigControl): string {
  const inForce = control.choices.find((choice) => choice.value === control.current)

  return inForce === undefined ? control.current : labelOf(control, inForce)
}

export function sessionControlRows(
  controls: readonly SessionConfigControl[],
): readonly SessionConfigControl[] {
  return (
    [...controls]
      .filter((control) => ORDER.includes(control.purpose))
      /* Swarm 不住在菜单里：它是上下文栏右端的一枚勾选（swarm-toggle.tsx）。
       一个控制只有一个住处，搬走那一行在同一次改动里删掉。 */
      .filter((control) => control.id !== SWARM_CONTROL_ID)
      .sort((left, right) => rank(left.purpose) - rank(right.purpose))
  )
}

/*
 * 档位在轨道上的落点。
 *
 * 轨道两端各留半个滑块，所以第一个与最后一个档位都停在轨道里；滑块中心、档位点、
 * 填充终点是同一条式子 —— 三样东西分别算一次就会错位。
 */
function stopOffset(position: number, count: number): string {
  const span = count - 1
  const ratio = span > 0 ? position / span : 0

  return `calc(var(--cp-model-thumb) / 2 + ${ratio} * (100% - var(--cp-model-thumb)))`
}

/*
 * 指针落在哪一个档位上：反解 stopOffset，不逐点测量。
 *
 * 档位点按与滑块同一条式子摆放，所以「最近的一档」就是这条式子的逆运算；每一帧读
 * 一次轨道盒子与滑块宽即可，与档位数无关。
 */
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
}

/** 入参只有 controls 会变，而这下面只有一张弹层加一个页签状态。 */
export const SessionControls = memo(function SessionControls({
  controls,
  onSelect,
}: SessionControlsProps) {
  const rows = useMemo(() => sessionControlRows(controls), [controls])
  const [pane, setPane] = useState<string>(LEVEL)

  const level = rows.find((control) => control.purpose === 'thought')
  const model = rows.find((control) => control.purpose === 'model')

  /* 没有控件可画就整个不画：连不上怎么说归输入区上沿那条提示（composer-notice.tsx）。 */
  if (level === undefined && model === undefined) {
    return null
  }

  const name = model === undefined ? undefined : chosen(model)
  const band = level === undefined ? undefined : chosen(level)

  /* 没有档位控件时，卡里只剩模型清单这一页。 */
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
                <Check aria-hidden="true" size={14} strokeWidth={2} />
              </DropdownMenuRadioItemIndicator>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </div>
    )

  const bandPane =
    level === undefined ? null : (
      <div className="assistant-model-select__band-pane">
        {/* 档位那一行整页换成模型清单；没有模型控件时它就只是一行字。 */}
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

              <ChevronRight
                aria-hidden="true"
                className="assistant-model-select__head-chevron"
                size={12}
                strokeWidth={2.5}
              />
            </span>

            <span className="assistant-model-select__head-name">{name}</span>
          </DropdownMenuItem>
        )}

        {rail(level, band ?? level.current, onSelect)}
      </div>
    )

  return (
    <DropdownMenu
      onOpenChange={(open) => {
        if (!open) {
          setPane(LEVEL)
        }
      }}
    >
      <DropdownMenuTrigger aria-label="模型与思考档位" className="assistant-model-select__button">
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
 * 离散轨道。
 *
 * 指针全归底轨自己：点一下、按住横拖，都走 setPointerCapture 加「落点反解出来的那一档」。
 * 档位是离散的，所以一次横拖最多换这么多次档（每跨一格一次），这里不另做节流。档位点
 * 那个命中区冒泡上来落到的也是底轨，所以「从点上起手拖」不会断。
 *
 * 原生 range 只剩键盘与 aria：指针一律穿透，滑块隐形（看得见的那颗是自己画的）。不这么
 * 分，滑块就跟不上换档的动画 —— 原生滑块的落点是布局算出来的，位置一变就是跳。
 *
 * 方向键必须在输入框上止住：菜单也监听方向键并且 preventDefault，放它冒泡上去，
 * 档位就一动不动。
 */
function rail(
  control: SessionConfigControl,
  band: string,
  onSelect: (controlId: string, value: string) => void,
) {
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
        /* 顺手把焦点交给输入框：点完接着按方向键微调，和点原生滑块时一样。 */
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

      <span
        className="assistant-model-select__thumb"
        style={{ insetInlineStart: stopOffset(at, count) }}
      />

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
