import { Menu } from '@base-ui/react/menu'
import type { ComponentProps } from 'react'
import { cn } from '../class-names'
import { popupPositionerClassName, popupSurfaceClassName } from './popup-surface'

export const DropdownMenu = Menu.Root

export const DropdownMenuGroup = Menu.Group

export const DropdownMenuRadioGroup = Menu.RadioGroup

export const DropdownMenuRadioItemIndicator = Menu.RadioItemIndicator

export function DropdownMenuTrigger({ className, ...props }: ComponentProps<typeof Menu.Trigger>) {
  return (
    <Menu.Trigger
      className={cn(
        'outline-none',
        'focus-visible:ring-2',
        'focus-visible:ring-ring',
        'focus-visible:ring-offset-2',
        'disabled:pointer-events-none',
        'disabled:opacity-50',
        className,
      )}
      {...props}
    />
  )
}

type DropdownMenuPopupProps = ComponentProps<typeof Menu.Popup> & {
  readonly sideOffset?: number
  readonly side?: ComponentProps<typeof Menu.Positioner>['side']
  readonly align?: ComponentProps<typeof Menu.Positioner>['align']
}

const popupClassName = cn(popupSurfaceClassName, 'min-w-32 p-1')

export function DropdownMenuContent({
  align = 'start',
  className,
  side = 'bottom',
  sideOffset = 6,
  ...props
}: DropdownMenuPopupProps) {
  return (
    <Menu.Portal>
      <Menu.Positioner
        align={align}
        className={popupPositionerClassName}
        side={side}
        sideOffset={sideOffset}
      >
        <Menu.Popup className={cn(popupClassName, className)} {...props} />
      </Menu.Positioner>
    </Menu.Portal>
  )
}

/* 行高读 --ui-menu-row-height；py-1 只在标签折行时参与计算。 */
const itemClassName = [
  'relative flex min-h-[var(--ui-menu-row-height)]',
  'cursor-default select-none',
  'items-center gap-2',
  'rounded-md px-2 py-1',
  'text-sm outline-none',
  'transition-colors',
  'focus:bg-[var(--ui-popup-highlight)]',
  'focus:text-foreground',
  'data-[highlighted]:bg-[var(--ui-popup-highlight)]',
  'data-[highlighted]:text-foreground',
  'data-[disabled]:pointer-events-none',
  'data-[disabled]:opacity-50',
].join(' ')

/*
 * A command in a menu. Its callback is onClick, because that is the callback
 * this menu has: Base UI's Menu.Item takes onClick and closes on click by
 * default. onSelect is a DOM event about text selection, and passing it here
 * type-checks, builds, and never fires.
 */
export function DropdownMenuItem({
  className,
  ...props
}: Omit<ComponentProps<typeof Menu.Item>, 'onSelect'>) {
  return <Menu.Item className={cn(itemClassName, className)} {...props} />
}

/*
 * A row that reports which value is in force.
 *
 * The role, aria-checked, the arrow keys and the mounting of the indicator all
 * belong to the group rather than to a data attribute: RadioGroup holds the
 * value, and the row whose value matches is the one that shows its indicator.
 */
export function DropdownMenuRadioItem({
  className,
  ...props
}: Omit<ComponentProps<typeof Menu.RadioItem>, 'onSelect'>) {
  return <Menu.RadioItem className={cn(itemClassName, className)} {...props} />
}

/*
 * 线画成上边框，不画成 1px 的色块：150% 缩放下 1px 是 1.5 个设备像素，色块的框
 * 被吸附到设备像素边界，落在半格上就铺满两行 —— 同一次渲染里浮层外框量到 1 行、
 * 这条线量到 2 行，所以它看着比外框粗；边框按整设备像素收边，位置再半格也是 1 行。
 *
 * 颜色写在 --color-divider 的局部值上，不写 border-* 的颜色类：app.css 里那条
 * `* { border-color: var(--color-divider) }` 是无层规则，压得过 @layer utilities 里
 * 的任何边框色类。各组自己的皮肤规则按选择器权重照旧覆盖它。
 */
export function DropdownMenuSeparator({
  className,
  ...props
}: ComponentProps<typeof Menu.Separator>) {
  return (
    <Menu.Separator
      className={cn('-mx-1 my-1 border-t [--color-divider:var(--ui-popup-divider)]', className)}
      {...props}
    />
  )
}
