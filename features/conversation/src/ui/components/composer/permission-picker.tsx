import './permission-picker.css'

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuRadioItemIndicator,
  DropdownMenuTrigger,
} from '@poietica/design-system'
import { Check, Hand, type LucideIcon, ShieldAlert, ShieldCheck } from 'lucide-react'
import { memo, useState } from 'react'
import type { SessionConfigControl } from '../../agent/config'
import { permissionControlOf, permissionPostureOf, permissionPosturesOf } from '../../configuration/permission-posture'

/*
 * 屏幕上的值只有一个来源：agent 报的控件表（control.current），没有第二份状态 —— 点一下就是发一次改动，值由答复换掉。
 * 唯一例外是 plan 期间：胶囊显示 posture-memory.ts 记下的挂起档位，那是只读记忆。档位是产品封闭取值域与 control.choices 的交集。
 */

/* 字形按产品自己的档位取，不按 agent 的 id 取。 */
const GLYPH: Readonly<Record<string, LucideIcon>> = {
  auto: ShieldAlert,
  manual: Hand,
  yolo: ShieldCheck,
}

function glyphOf(value: string): LucideIcon {
  return GLYPH[value] ?? Hand
}

export interface PermissionPickerProps {
  readonly controls: readonly SessionConfigControl[]
  readonly onSelect: (controlId: string, value: string) => void
  /**
   * 这张表还没被 agent 确认过（开窗时从盘上读回来的那一份）：画法不变，只是点不动。拦在 onOpenChange 里而不是用 disabled：DropdownMenuTrigger 自带 disabled:opacity-50。
   */
  readonly pending?: boolean | undefined
  /**
   * 只画字形，不画档位名：辅助对话那一栏最窄只有 320，一行里还要放模型名与草稿。字形仍按档位取色（完全访问那一档是橙的），档位名在弹层里逐档写全。
   */
  readonly iconOnly?: boolean
}

/* 记住不重建：controls 只在 agent 报新表时换引用。 */
export const PermissionPicker = memo(function PermissionPicker({
  controls,
  iconOnly,
  onSelect,
  pending,
}: PermissionPickerProps) {
  const [open, setOpen] = useState(false)
  const control = permissionControlOf(controls)

  if (control === undefined) {
    return null
  }

  const rows = permissionPosturesOf(control)

  if (rows.length === 0) {
    return null
  }

  /* Plan 期间批准方式只是被挂起：胶囊必须常显，互斥隐藏会让人看不见自己此刻授了多大的权。 */
  const currentPosture = control.current
  const current = permissionPostureOf(currentPosture)

  if (current === undefined) {
    return null
  }

  const Mark = glyphOf(currentPosture)

  return (
    <DropdownMenu
      onOpenChange={(nextOpen) => {
        /* 未确认时开不动，但外观不变：不摆出一副「这格坏了」的样子。 */
        if (pending) {
          return
        }

        setOpen(nextOpen)
      }}
      open={open}
    >
      <DropdownMenuTrigger
        aria-busy={pending ? true : undefined}
        aria-disabled={pending ? true : undefined}
        aria-label="批准方式"
        className="assistant-posture"
        data-alert={current.alerts ? 'true' : undefined}
        data-icon-only={iconOnly ? 'true' : undefined}
      >
        <Mark aria-hidden="true" />

        {iconOnly ? null : <span className="assistant-posture__label">{current.pill}</span>}
      </DropdownMenuTrigger>

      <DropdownMenuContent
        align="start"
        className="assistant-posture-menu"
        data-assistant-skin
        side="top"
        sideOffset={6}
      >
        <DropdownMenuRadioGroup
          onValueChange={(value) => {
            if (value === currentPosture) {
              return
            }
            onSelect(control.id, value)
            setOpen(false)
          }}
          value={currentPosture}
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
                  <Check aria-hidden="true" />
                </DropdownMenuRadioItemIndicator>
              </DropdownMenuRadioItem>
            )
          })}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
})
