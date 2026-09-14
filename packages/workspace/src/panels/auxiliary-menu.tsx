import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@poietica/design-system'
import { ChevronRight, Minus, MoreHorizontal, Plus, RotateCcw } from 'lucide-react'
import { type ReactNode, useLayoutEffect, useRef } from 'react'
import type { AuxiliaryLauncherKind } from './auxiliary-panel-store'

/*
 * 面板两张菜单的唯一实现：加号、更多操作。标签下拉已让位给全屏按钮（标签条里）。
 *
 * 菜单是主文档里的 DOM，定位、碰撞翻转、键盘与 aria 归 @poietica/design-system 的
 * DropdownMenu；展开期间原生子 webview 由 browser-dock 让位。行高读控件小号
 * 令牌、字号 text-xs —— 与标签条同一套量纲，量纲一律走类。
 */

/** 加号菜单里可开的通道种类，由宿主提供。 */
export interface AuxiliaryPaneOffer {
  readonly kind: AuxiliaryLauncherKind
  readonly label: string
  readonly description: string
  readonly availability: 'ready' | 'planned'
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
  onOpenPane,
  open,
}: {
  readonly offers: readonly AuxiliaryPaneOffer[]
  readonly onHeightChange: (height: number) => void
  readonly onOpenChange: (open: boolean) => void
  readonly onOpenPane: (kind: AuxiliaryLauncherKind) => void
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
            onOpenPane(offer.kind)
          }}
        >
          {offer.icon}
          <span className={labelClassName}>{offer.label}</span>
        </DropdownMenuItem>
      ))}
    </MenuShell>
  )
}

type OverflowRow =
  | { readonly kind: 'divider'; readonly id: string }
  | { readonly kind: 'zoom'; readonly id: string }
  | {
      readonly kind: 'command'
      readonly id: string
      readonly label: string
      readonly disabled?: true
      readonly submenu?: true
    }

/* 行清单只有这一份。命令还没接进来：灰行禁用，其余点了只关菜单。 */
const OVERFLOW_ROWS: readonly OverflowRow[] = [
  { kind: 'command', id: 'find-in-page', label: '在页面中查找' },
  { kind: 'command', id: 'print', label: '打印', disabled: true },
  { kind: 'divider', id: 'after-print' },
  { kind: 'zoom', id: 'zoom' },
  { kind: 'divider', id: 'after-zoom' },
  { kind: 'command', id: 'device-toolbar', label: '显示设备工具栏' },
  { kind: 'command', id: 'screenshot', label: '截取屏幕截图', disabled: true },
  { kind: 'divider', id: 'after-capture' },
  { kind: 'command', id: 'import-credentials', label: '导入 Cookie 和密码…' },
  { kind: 'command', id: 'credentials', label: '密码和自动填充', submenu: true },
  { kind: 'command', id: 'downloads', label: '下载' },
  { kind: 'command', id: 'history', label: '历史记录' },
  { kind: 'command', id: 'clear-browsing-data', label: '清除浏览数据' },
  { kind: 'divider', id: 'after-data' },
  { kind: 'command', id: 'settings', label: '浏览器设置' },
]

/* 缩放的三个键只画不做事：面板还没有缩放这条命令。 */
function ZoomStep({ children, label }: { readonly children: ReactNode; readonly label: string }) {
  return (
    <button
      aria-label={label}
      className="flex size-6 shrink-0 items-center justify-center rounded-md opacity-50"
      disabled
      title={label}
      type="button"
    >
      {children}
    </button>
  )
}

function ZoomRow() {
  return (
    <fieldset
      aria-label="缩放"
      className="flex min-h-[var(--ui-control-height-sm)] items-center gap-1 px-2"
    >
      <span className={labelClassName}>缩放</span>
      <ZoomStep label="缩小">
        <Minus aria-hidden className="size-3.5" />
      </ZoomStep>
      <span className="w-10 shrink-0 text-center text-xs tabular-nums opacity-70">100%</span>
      <ZoomStep label="放大">
        <Plus aria-hidden className="size-3.5" />
      </ZoomStep>
      <ZoomStep label="重置缩放">
        <RotateCcw aria-hidden className="size-3.5" />
      </ZoomStep>
    </fieldset>
  )
}

export function BrowserOverflowMenu({
  onHeightChange,
  onOpenChange,
  open,
}: {
  readonly onHeightChange: (height: number) => void
  readonly onOpenChange: (open: boolean) => void
  readonly open: boolean
}) {
  return (
    <MenuShell
      className="w-64"
      icon={<MoreHorizontal aria-hidden className="size-4" />}
      label="更多操作"
      onHeightChange={onHeightChange}
      onOpenChange={onOpenChange}
      open={open}
    >
      {OVERFLOW_ROWS.map((row) => {
        if (row.kind === 'divider') {
          return <DropdownMenuSeparator key={row.id} />
        }

        if (row.kind === 'zoom') {
          return <ZoomRow key={row.id} />
        }

        return (
          <DropdownMenuItem disabled={row.disabled ?? false} key={row.id}>
            <span className={labelClassName}>{row.label}</span>
            {row.submenu === true ? (
              <ChevronRight aria-hidden className="size-3.5 shrink-0 opacity-50" />
            ) : null}
          </DropdownMenuItem>
        )
      })}
    </MenuShell>
  )
}
