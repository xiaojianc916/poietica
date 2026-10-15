import { Menu } from '@base-ui/react/menu'
import { Check } from 'lucide-react'
import type { ComponentProps, ReactNode } from 'react'
import { cn } from '../class-names'
import './menu.css'
import {
  menuCardClassName,
  menuCheckClassName,
  menuItemClassName,
  menuItemDangerClassName,
  menuLabelClassName,
  menuScrollableClassName,
  menuSeparatorClassName,
  popupPositionerClassName,
  popupSurfaceClassName,
} from './popup-surface'

export const DropdownMenu = Menu.Root

export const DropdownMenuGroup = Menu.Group

export const DropdownMenuRadioGroup = Menu.RadioGroup

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
  /** 正本的 dense：行 34 → 30，只压行距，排版与卡宽不动。 */
  readonly dense?: boolean
  /** 正本的 compact：整档缩小（行 24、字 11/17、图标与勾 12、卡 156 起）。 */
  readonly compact?: boolean
  /** 名单长到超过视口时在卡内滚（正本 .scrollable）。短名单不必戴。 */
  readonly scrollable?: boolean
}

/*
 * 卡片与锚点的间距是 4（正本 .list 的 top: calc(100% + 4px)，传送门那一路同样 +4），不是更常见
 * 的 6：菜单贴着触发器开，两张面之间那条缝才不至于读成第三个平面。
 */
export function DropdownMenuContent({
  align = 'start',
  className,
  compact = false,
  dense = false,
  scrollable = false,
  side = 'bottom',
  sideOffset = 4,
  ...props
}: DropdownMenuPopupProps) {
  return (
    <Menu.Portal>
      <Menu.Positioner align={align} className={popupPositionerClassName} side={side} sideOffset={sideOffset}>
        <Menu.Popup
          className={cn(
            popupSurfaceClassName,
            menuCardClassName,
            dense && 'ds-menu-dense',
            compact && 'ds-menu-compact',
            scrollable && menuScrollableClassName,
            className,
          )}
          {...props}
        />
      </Menu.Positioner>
    </Menu.Portal>
  )
}

/*
 * 一组选项的标题（正本 .label）。它不是 menuitem：不进键盘走位、不吃指针，读屏也读不到 —— 那一行
 * 是给眼睛分组用的，组本身该由 DropdownMenuGroup 表达。
 */
export function DropdownMenuLabel({ className, ...props }: ComponentProps<'div'>) {
  return <div className={cn(menuLabelClassName, className)} role="presentation" {...props} />
}

/*
 * 一个命令。它的回调是 onClick，因为那就是这个菜单的回调：Base UI 的 Menu.Item 收 onClick 并在
 * 点击后关闭。onSelect 是 DOM 的文本选择事件，传进来能过类型、能构建，且永远不会触发。
 *
 * danger 是正本 .danger 的那一档：删掉之类的行整行红字、高亮走软红底。危险不再靠调用点自己贴
 * 一个 text-destructive —— 那样图标那一格会留在菜单图标的灰上。
 */
type DropdownMenuItemProps = Omit<ComponentProps<typeof Menu.Item>, 'onSelect'> & {
  readonly danger?: boolean
}

export function DropdownMenuItem({ className, danger = false, ...props }: DropdownMenuItemProps) {
  return <Menu.Item className={cn(menuItemClassName, danger && menuItemDangerClassName, className)} {...props} />
}

/*
 * 选中那枚勾（正本 .check）。不给子级时画本仓自己的勾：单选组于是不必各自引一枚图标，选中的样子
 * 只有一个产地。
 */
export function DropdownMenuRadioItemIndicator({
  children,
  className,
  ...props
}: ComponentProps<typeof Menu.RadioItemIndicator>) {
  return (
    <Menu.RadioItemIndicator className={cn(menuCheckClassName, className)} {...props}>
      {children ?? <Check aria-hidden="true" />}
    </Menu.RadioItemIndicator>
  )
}

/*
 * 行尾那枚勾，给非单选的选中行用（正本里 .selected 与 .selectedFill 的区别就在这一枚勾）。
 */
export function DropdownMenuCheck({
  className,
  ...props
}: Omit<ComponentProps<typeof Check>, 'ref'>): ReactNode {
  return <Check aria-hidden="true" className={cn(menuCheckClassName, className)} {...props} />
}

/*
 * 一行单选。它和普通行是同一张脸，只多一个值：值在 RadioGroup 上，行只负责报值。
 */
export function DropdownMenuRadioItem({
  className,
  ...props
}: Omit<ComponentProps<typeof Menu.RadioItem>, 'onSelect'>) {
  return <Menu.RadioItem className={cn(menuItemClassName, className)} {...props} />
}

/* 各组自己的皮肤规则按选择器权重覆盖这一份的分隔线颜色。 */
export function DropdownMenuSeparator({ className, ...props }: ComponentProps<typeof Menu.Separator>) {
  return <Menu.Separator className={cn(menuSeparatorClassName, className)} {...props} />
}
