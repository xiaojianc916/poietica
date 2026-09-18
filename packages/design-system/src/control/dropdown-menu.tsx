import { Menu } from '@base-ui/react/menu'
import type { ComponentProps } from 'react'
import { cn } from '../class-names'
import {
  menuItemClassName,
  menuSeparatorClassName,
  popupPositionerClassName,
  popupSurfaceClassName,
} from './popup-surface'

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
  return <Menu.Item className={cn(menuItemClassName, className)} {...props} />
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
  return <Menu.RadioItem className={cn(menuItemClassName, className)} {...props} />
}

/* 各组自己的皮肤规则按选择器权重覆盖这一份的分隔线颜色。 */
export function DropdownMenuSeparator({
  className,
  ...props
}: ComponentProps<typeof Menu.Separator>) {
  return <Menu.Separator className={cn(menuSeparatorClassName, className)} {...props} />
}
