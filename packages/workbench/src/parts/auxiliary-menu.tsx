import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@poietica/design-system'
import { Plus } from 'lucide-react'
import { type ReactNode, useLayoutEffect, useRef } from 'react'

/*
 * 辅助面板加号菜单的唯一实现。**迁移自** legacy
 * `packages/workspace/src/panels/auxiliary-menu.tsx` 的 MenuShell + AuxiliaryNewTabMenu。
 *
 * 菜单是主文档里的 DOM，定位、碰撞翻转、键盘与 aria 归 @poietica/design-system 的
 * DropdownMenu；行高读控件小号令牌、字号 text-xs —— 与标签条同一套量纲，量纲一律走类。
 *
 * 与 legacy 唯一的差别是 offer 的 kind 现在是**面板贡献 id**（新架构里一个可开的
 * 落点就是一条贡献），不再是一组写死的通道字面量；视觉、DOM 形状与展开行为一字未改。
 */

/** 加号菜单与启动器共用一条 offer：能开什么由两者分别按 offer!==false 过滤后传进来。 */
export interface AuxiliaryOffer {
  readonly kind: string
  readonly label: string
  readonly description: string
  readonly icon: ReactNode
}

const triggerClassName =
  'flex size-6 shrink-0 items-center justify-center rounded-md opacity-60 hover:bg-launcher hover:opacity-100'

/** 行里的标签位：一份，两张菜单共用。 */
const labelClassName = 'min-w-0 flex-1 truncate text-xs'

function MenuShell({
  children,
  className,
  icon,
  label,
  onHeightChange,
  onOpenChange,
  open,
}: {
  readonly children: ReactNode
  readonly className: string
  readonly icon: ReactNode
  readonly label: string
  readonly onHeightChange: (height: number) => void
  readonly onOpenChange: (open: boolean) => void
  readonly open: boolean
}) {
  const popup = useRef<HTMLDivElement | null>(null)

  useLayoutEffect(() => {
    const element = popup.current
    if (!open || element === null) {
      onHeightChange(0)
      return undefined
    }

    const report = () => onHeightChange(Math.ceil(element.getBoundingClientRect().height + 6))
    report()
    const observer = new ResizeObserver(report)
    observer.observe(element)
    return () => observer.disconnect()
  }, [onHeightChange, open])

  return (
    <DropdownMenu onOpenChange={onOpenChange} open={open}>
      <DropdownMenuTrigger aria-label={label} className={triggerClassName} title={label}>
        {icon}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className={className} ref={popup}>
        {children}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function AuxiliaryNewTabMenu({
  offers,
  onHeightChange,
  onOpenChange,
  onOpen,
  open,
}: {
  readonly offers: readonly AuxiliaryOffer[]
  readonly onHeightChange: (height: number) => void
  readonly onOpenChange: (open: boolean) => void
  readonly onOpen: (kind: string) => void
  readonly open: boolean
}) {
  return (
    <MenuShell
      className="min-w-40"
      icon={<Plus aria-hidden className="size-4" />}
      label="新建标签页"
      onHeightChange={onHeightChange}
      onOpenChange={onOpenChange}
      open={open}
    >
      {offers.map((offer) => (
        <DropdownMenuItem
          key={offer.kind}
          onClick={() => {
            onOpen(offer.kind)
          }}
        >
          {offer.icon}
          <span className={labelClassName}>{offer.label}</span>
        </DropdownMenuItem>
      ))}
    </MenuShell>
  )
}
