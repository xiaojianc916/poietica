import { DropdownMenuItem, ToolbarMenu, ToolbarMenuLabel } from '@poietica/design-system'
import { Plus } from 'lucide-react'
import type { ReactNode } from 'react'

/*
 * 辅助面板加号菜单。定位、碰撞翻转、键盘与 aria 归 @poietica/design-system 的 DropdownMenu；
 * 量纲一律走类。offer 的 kind 是**面板贡献 id**。
 */

/** 加号菜单与启动器共用的 offer；由调用方按 offer !== false 过滤后传进来。 */
export interface AuxiliaryOffer {
  readonly kind: string
  readonly label: string
  readonly description: string
  readonly icon: ReactNode
}

export function AuxiliaryNewTabMenu({
  offers,
  onOpenChange,
  onOpen,
  open,
}: {
  readonly offers: readonly AuxiliaryOffer[]
  readonly onOpenChange: (open: boolean) => void
  readonly onOpen: (kind: string) => void
  readonly open: boolean
}) {
  return (
    <ToolbarMenu
      className="min-w-40"
      icon={<Plus aria-hidden />}
      label="新建标签页"
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
          <ToolbarMenuLabel>{offer.label}</ToolbarMenuLabel>
        </DropdownMenuItem>
      ))}
    </ToolbarMenu>
  )
}
