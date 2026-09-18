import { ContextMenu } from '@base-ui/react/context-menu'
import type { ComponentProps } from 'react'
import { cn } from '../class-names'
import {
  menuItemClassName,
  menuSeparatorClassName,
  popupPositionerClassName,
  popupSurfaceClassName,
} from './popup-surface'

/*
 * 右键菜单。与 DropdownMenu 是同一族的两个入口，共用浮层表面、定位层与行样式：
 * 落点、碰撞翻转、键盘与 aria 全归 Base UI 的 Positioner 与复合列表，调用方只描述
 * 菜单里有什么。
 *
 * 用 ContextMenu 而不是 Menu 加一个虚拟锚点：前者把「锚点是右键落点」这件事写在
 * 定位层里（fixed 定位、align start、沿副轴的 shift），后者要调用方每帧自己造一个
 * 零尺寸矩形。位置只有一个产地。
 */

export const ContextMenuRoot = ContextMenu.Root

/*
 * 触发区。渲染成 div，右键落点由它内部的 ContextMenu 上下文接管：整片区域一个
 * 触发区即可，不必每个格子各挂一个 Root。调用方传进来的 onContextMenu 会被合并，
 * 且在 Base UI 自己那一个之前执行 —— 不想开菜单时，在那里调 preventBaseUIHandler。
 */
export const ContextMenuTrigger = ContextMenu.Trigger

type ContextMenuContentProps = ComponentProps<typeof ContextMenu.Popup>

export function ContextMenuContent({ className, ...props }: ContextMenuContentProps) {
  return (
    <ContextMenu.Portal>
      <ContextMenu.Positioner className={popupPositionerClassName}>
        <ContextMenu.Popup
          className={cn(popupSurfaceClassName, 'min-w-32 p-1', className)}
          {...props}
        />
      </ContextMenu.Positioner>
    </ContextMenu.Portal>
  )
}

/* 回调是 onClick：这是这套菜单给的入口，onSelect 是 DOM 的文本选择事件。 */
export function ContextMenuItem({
  className,
  ...props
}: Omit<ComponentProps<typeof ContextMenu.Item>, 'onSelect'>) {
  return <ContextMenu.Item className={cn(menuItemClassName, className)} {...props} />
}

export function ContextMenuSeparator({
  className,
  ...props
}: ComponentProps<typeof ContextMenu.Separator>) {
  return <ContextMenu.Separator className={cn(menuSeparatorClassName, className)} {...props} />
}
