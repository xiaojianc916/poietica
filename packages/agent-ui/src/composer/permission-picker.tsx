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
import { Hand, type LucideIcon, ShieldAlert, ShieldCheck } from 'lucide-react'
import { memo, useState } from 'react'
import { CheckIcon } from '../primitives/icons'
import { usePostureMemory } from './posture-memory'

/*
 * 批准方式那颗胶囊，以及它打开的那一张。
 *
 * 屏幕上的值只有一个来源：agent 报的那张控件表（control.current）。这里没有第二
 * 份状态，也没有「显示值」与「实际值」两格 —— 点一下就是往 agent 发一次改动，值
 * 由它的答复换掉。持久意图归 PermissionPosturePort，与这一层无关。
 *
 * 唯一例外：plan 期间控制值是 'plan'，批准方式被协议覆写丢失，胶囊显示的是挂起
 * 的那一档（posture-memory.ts 从同一条控制流记下的最后值）。它不是第二份可写
 * 状态，只是「退出 plan 后要还回去的那个值」的只读记忆。
 *
 * 档位是产品的封闭取值域与 control.choices 的交集，所以 agent 多报的档位不会漏
 * 到屏幕上 —— 这是结构上排除，不是渲染时过滤。
 *
 * 弹层行为全部归 Base UI（设计系统的 DropdownMenu）：role=menuitemradio、方向键、
 * 打字选中、Esc 关闭、焦点归还。这里只给皮肤与文案。
 */

/*
 * 字形按产品自己的档位取，不按 agent 的 id 取。
 *
 * 权限切换从这里开始迁移到 Lucide，其他界面仍可继续使用原有图标库。
 *
 * 当前档位在菜单中的顺序是：
 * manual（请求批准）、yolo（帮我批准）、auto（完全访问权限）。
 */
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
}

/*
 * 记住不重建，与工具条里另外两簇同一条规矩。controls 只在 agent 报新表时换引用。
 */
export const PermissionPicker = memo(function PermissionPicker({
  controls,
  onSelect,
}: PermissionPickerProps) {
  const [open, setOpen] = useState(false)
  const rememberedPosture = usePostureMemory(controls)
  const control = permissionControlOf(controls)

  if (control === undefined) {
    return null
  }

  const rows = permissionPosturesOf(control)

  if (rows.length === 0) {
    return null
  }

  /* Plan 期间批准方式只是被挂起：胶囊继续显示挂起的那一档，菜单里改选另一档即
     退出 plan。互斥隐藏会让人看不见自己此刻授了多大的权 —— 这颗胶囊必须常显。 */
  const currentPosture = rememberedPosture ?? control.current
  const current = permissionPostureOf(currentPosture)

  if (current === undefined) {
    return null
  }

  const Mark = glyphOf(currentPosture)

  return (
    <DropdownMenu
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen)
      }}
      open={open}
    >
      <DropdownMenuTrigger
        aria-label="批准方式"
        className="assistant-posture"
        data-alert={current.alerts ? 'true' : undefined}
      >
        <Mark aria-hidden="true" />

        <span className="assistant-posture__label">{current.pill}</span>
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
