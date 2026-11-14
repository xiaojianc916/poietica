import type { ReactNode } from 'react'
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from './dropdown-menu'

/*
 * 右坞工具栏那一排「加号 / 更多」菜单的公用壳：触发器尺寸、悬停底色与标题文案只有这一份。
 * 浏览器面板与外层面板都长在同一个工具栏上，各自抄一遍就会一边 24px、一边 28px。
 */

export function ToolbarMenu({
  children,
  className,
  icon,
  label,
  onOpenChange,
  open,
}: {
  readonly children: ReactNode
  readonly className: string
  readonly icon: ReactNode
  readonly label: string
  readonly onOpenChange: (open: boolean) => void
  readonly open: boolean
}) {
  return (
    <DropdownMenu onOpenChange={onOpenChange} open={open}>
      <DropdownMenuTrigger
        aria-label={label}
        className="flex size-6 shrink-0 items-center justify-center rounded-md opacity-60 hover:bg-launcher hover:opacity-100"
        title={label}
      >
        {icon}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className={className}>
        {children}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** 菜单行里那格可截断的文字。 */
export function ToolbarMenuLabel({ children }: { readonly children: ReactNode }) {
  return <span className="min-w-0 flex-1 truncate text-xs">{children}</span>
}
