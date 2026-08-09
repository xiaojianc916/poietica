import './permission-picker.css'

import { permissionControlOf, permissionPostureOf, permissionPosturesOf } from '@poietica/agent'
import type { SessionConfigControl } from '@poietica/agent-contract'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuRadioItemIndicator,
  DropdownMenuTrigger,
} from '@poietica/ui'
import { type ComponentType, memo } from 'react'
import { CheckIcon, GlobeIcon, ModelIcon, ThreadIcon } from '../primitives/icons'

/*
 * 批准方式那颗胶囊，以及它打开的那一张。
 *
 * 屏幕上的值只有一个来源：agent 报的那张控件表（control.current）。这里没有第二
 * 份状态，也没有「显示值」与「实际值」两格 —— 点一下就是往 agent 发一次改动，值
 * 由它的答复换掉。持久意图归 PermissionPosturePort，与这一层无关。
 *
 * 档位是产品的封闭取值域与 control.choices 的交集，所以 agent 多报的档位不会漏
 * 到屏幕上 —— 这是结构上排除，不是渲染时过滤。
 *
 * 弹层行为全部归 Base UI（设计系统的 DropdownMenu）：role=menuitemradio、方向键、
 * 打字选中、Esc 关闭、焦点归还。这里只给皮肤与文案。
 */

/** 图标槽位的最小 props 契约：放宽到完整 SVG props 会在
 *  exactOptionalPropertyTypes 下与图标库的 props 逆变冲突。 */
type GlyphProps = {
  'aria-hidden'?: 'true'
  className?: string
}

type Glyph = ComponentType<GlyphProps>

/*
 * 字形按产品自己的档位取，不按 agent 的 id 取。
 *
 * 完全访问那一档用地球：它的说明写的就是「不受限制地访问互联网和您电脑上的任何
 * 文件」。提醒靠颜色（data-alert），不靠再叠一个警告字形。
 */
const GLYPH: Readonly<Record<string, Glyph>> = {
  auto: GlobeIcon,
  default: ThreadIcon,
  yolo: ModelIcon,
}

function glyphOf(value: string): Glyph {
  return GLYPH[value] ?? ModelIcon
}

export interface PermissionPickerProps {
  readonly controls: readonly SessionConfigControl[]
  readonly onSelect: (controlId: string, value: string) => void
}

/*
 * 记住不重建，与工具条里另外两簇同一条规矩。controls 只在 agent 报新表时换引用。
 */
export const PermissionPicker = memo(function PermissionPicker({
  controls,
  onSelect,
}: PermissionPickerProps) {
  const control = permissionControlOf(controls)

  if (control === undefined) {
    return null
  }

  const rows = permissionPosturesOf(control)

  if (rows.length === 0) {
    return null
  }

  const current = permissionPostureOf(control.current)
  const Mark = glyphOf(control.current)

  /*
   * 认不得的档位显示 agent 自己的说法。
   *
   * 宁可露出一个英文名，也不能拿一个我们编的中文名去盖住一个我们没定义过的档位
   * —— 与 permission-dock 的 labelFor 同一条规矩。
   */
  const label =
    current?.pill ??
    control.choices.find((choice) => choice.value === control.current)?.label ??
    control.current

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label="批准方式"
        className="assistant-posture"
        data-alert={current?.alerts === true ? 'true' : undefined}
      >
        <Mark aria-hidden="true" />

        <span className="assistant-posture__label">{label}</span>
      </DropdownMenuTrigger>

      <DropdownMenuContent
        align="start"
        className="assistant-posture-menu assistant-menu-surface"
        data-assistant-skin
        side="top"
        sideOffset={6}
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
          {rows.map((posture) => {
            const Row = glyphOf(posture.value)

            return (
              <DropdownMenuRadioItem
                className="assistant-posture-menu__item"
                data-alert={posture.alerts ? 'true' : undefined}
                key={posture.value}
                value={posture.value}
              >
                <Row aria-hidden="true" className="assistant-posture-menu__glyph" />

                <span className="assistant-posture-menu__name">{posture.title}</span>

                <span className="assistant-posture-menu__detail">{posture.detail}</span>

                <DropdownMenuRadioItemIndicator className="assistant-posture-menu__tick">
                  <CheckIcon aria-hidden="true" />
                </DropdownMenuRadioItemIndicator>
              </DropdownMenuRadioItem>
            )
          })}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
})
