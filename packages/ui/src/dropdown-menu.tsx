import { Menu } from '@base-ui/react/menu'
import type { ComponentProps } from 'react'
import { cn } from './class-names'
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

/*
 * 一张浮层，说一次。
 *
 * 主菜单与子菜单此前是两份逐字节相同的类型声明，加两份逐字节相同的
 * Portal → Positioner → Popup。两者真正的差别只有两个默认值：贴哪一边、离多远。
 * 这个文件上面刚把两份相同的行样式合成 itemClassName，同一份文件里不该有两套
 * 标准。
 */
type DropdownMenuPopupProps = ComponentProps<typeof Menu.Popup> & {
  readonly sideOffset?: number
  readonly side?: ComponentProps<typeof Menu.Positioner>['side']
  readonly align?: ComponentProps<typeof Menu.Positioner>['align']
}

const popupClassName = cn(popupSurfaceClassName, 'min-w-32 p-1')

function MenuPopup({
  align = 'start',
  className,
  side,
  sideOffset,
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

/* 主菜单贴下沿。6 与 4 的差别是有意的：子菜单贴着父行展开，离得更近。 */
export function DropdownMenuContent({
  side = 'bottom',
  sideOffset = 6,
  ...props
}: DropdownMenuPopupProps) {
  return <MenuPopup side={side} sideOffset={sideOffset} {...props} />
}

/*
 * One menu row, stated once.
 *
 * Item and SubmenuTrigger were two copies of the same twelve classes, and a
 * radio row would have made three. The only difference belongs to the trigger,
 * which also paints while its submenu is open, so it adds that one class
 * instead of restating the rest.
 */
/*
 * 行高读 --ui-control-height-sm，不写 min-h-9。
 *
 * 36px 是 shadcn / Radix 的 web 默认值，前提是手指点击。这是鼠标产品：
 * macOS 菜单行约 22px，Fluent 的 MenuFlyoutItem 32px，VS Code 26px。最小
 * 命中区不是行高，此前把两者当成了一个数。
 *
 * 换成令牌之后，菜单行与应用里其他控件读同一个高度 —— 在此之前这里是全局
 * 唯一一处不读令牌的控件高度。
 *
 * py-1.5 保留：32px 下它是惰性的（6 + 16 + 6 = 28 < 32），但标签折行时它是
 * 唯一的保护。
 */
const itemClassName = [
  'relative flex min-h-[var(--ui-control-height-sm)]',
  'cursor-default select-none',
  'items-center gap-2',
  'rounded-sm px-2 py-1.5',
  'text-sm outline-none',
  'transition-colors',
  'focus:bg-accent',
  'focus:text-accent-foreground',
  'data-[highlighted]:bg-accent',
  'data-[highlighted]:text-accent-foreground',
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

export function DropdownMenuSeparator({
  className,
  ...props
}: ComponentProps<typeof Menu.Separator>) {
  return <Menu.Separator className={cn('-mx-1 my-1 h-px', 'bg-divider', className)} {...props} />
}
