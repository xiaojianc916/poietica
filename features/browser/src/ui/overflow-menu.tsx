import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@poietica/design-system'
import { ChevronRight, History, Minus, MoreHorizontal, Plus, RotateCcw } from 'lucide-react'
import { type ReactNode, useLayoutEffect, useRef } from 'react'

/* 工具栏右端那张「更多操作」菜单。菜单壳、行清单、行类名、缩放步进照 legacy；换掉三处口径：没接进来的条目不再假装存在、缩放范围按契约 browser.setZoom 的 -3…5、最近关闭是新增的。 */

const triggerClassName =
  'flex size-6 shrink-0 items-center justify-center rounded-md opacity-60 hover:bg-launcher hover:opacity-100'

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

    const report = (): void => {
      onHeightChange(Math.ceil(element.getBoundingClientRect().height + 6))
    }

    report()
    const observer = new ResizeObserver(report)
    observer.observe(element)
    return () => {
      observer.disconnect()
    }
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

const ZOOM_STEP = 1
export const ZOOM_MIN = -3
export const ZOOM_MAX = 5

function ZoomStep({
  children,
  label,
  onClick,
}: {
  readonly children: ReactNode
  readonly label: string
  readonly onClick: () => void
}) {
  return (
    <button
      aria-label={label}
      className="flex size-6 shrink-0 items-center justify-center rounded-md hover:bg-current/10"
      onClick={onClick}
      title={label}
      type="button"
    >
      {children}
    </button>
  )
}

function ZoomRow({ onZoom, level }: { readonly onZoom: (level: number) => void; readonly level: number }) {
  const percent = Math.round(1.2 ** level * 100)

  return (
    <fieldset aria-label="缩放" className="flex min-h-[var(--ui-control-height-sm)] items-center gap-1 px-2">
      <span className={labelClassName}>缩放</span>
      <ZoomStep label="缩小" onClick={() => onZoom(Math.max(ZOOM_MIN, level - ZOOM_STEP))}>
        <Minus aria-hidden className="size-3.5" />
      </ZoomStep>
      <span className="w-10 shrink-0 text-center text-xs tabular-nums opacity-70">{percent}%</span>
      <ZoomStep label="放大" onClick={() => onZoom(Math.min(ZOOM_MAX, level + ZOOM_STEP))}>
        <Plus aria-hidden className="size-3.5" />
      </ZoomStep>
      <ZoomStep label="重置缩放" onClick={() => onZoom(0)}>
        <RotateCcw aria-hidden className="size-3.5" />
      </ZoomStep>
    </fieldset>
  )
}

export interface BrowserOverflowMenuProps {
  readonly commands: Readonly<Partial<Record<string, () => void>>>
  readonly onHeightChange: (height: number) => void
  readonly onOpenChange: (open: boolean) => void
  readonly onReopen: (index: number) => void
  readonly onZoom: (level: number) => void
  readonly open: boolean
  readonly recentlyClosed: readonly { readonly url: string; readonly title: string }[]
  readonly zoomLevel: number
}

type OverflowRow =
  | { readonly kind: 'divider'; readonly id: string }
  | { readonly kind: 'zoom'; readonly id: string }
  | {
      readonly kind: 'command'
      readonly id: string
      readonly label: string
      readonly submenu?: true
    }

const OVERFLOW_ROWS: readonly OverflowRow[] = [
  { kind: 'command', id: 'find-in-page', label: '在页面中查找' },
  { kind: 'command', id: 'print', label: '打印' },
  { kind: 'divider', id: 'after-print' },
  { kind: 'zoom', id: 'zoom' },
  { kind: 'divider', id: 'after-zoom' },
  { kind: 'command', id: 'device-toolbar', label: '显示设备工具栏' },
  { kind: 'command', id: 'screenshot', label: '截取屏幕截图' },
  { kind: 'divider', id: 'after-capture' },
  { kind: 'command', id: 'import-credentials', label: '导入 Cookie 和密码…' },
  { kind: 'command', id: 'credentials', label: '密码和自动填充', submenu: true },
  { kind: 'command', id: 'downloads', label: '下载' },
  { kind: 'command', id: 'history', label: '历史记录' },
  { kind: 'command', id: 'clear-browsing-data', label: '清除浏览数据' },
  { kind: 'divider', id: 'after-data' },
  { kind: 'command', id: 'settings', label: '浏览器设置' },
]

function CommandRow({
  command,
  label,
  submenu,
}: {
  readonly command: (() => void) | undefined
  readonly label: string
  readonly submenu?: true
}) {
  return (
    <DropdownMenuItem
      disabled={command === undefined}
      onClick={() => {
        command?.()
      }}
    >
      <span className={labelClassName}>{label}</span>
      {submenu === true ? <ChevronRight aria-hidden className="size-3.5 shrink-0 opacity-50" /> : null}
    </DropdownMenuItem>
  )
}

export function BrowserOverflowMenu({
  commands,
  onHeightChange,
  onOpenChange,
  onReopen,
  onZoom,
  open,
  recentlyClosed,
  zoomLevel,
}: BrowserOverflowMenuProps) {
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
          return <ZoomRow key={row.id} level={zoomLevel} onZoom={onZoom} />
        }

        return (
          <CommandRow
            command={commands[row.id]}
            key={row.id}
            label={row.label}
            {...(row.submenu === true ? { submenu: true as const } : {})}
          />
        )
      })}

      {/*
       * 「最近关闭」是 07 页 §12E 点名、而 legacy 里没有 UI 的那一栏：接在 legacy 那张
       * 行清单之后，行样式沿用同一套 DropdownMenuItem，不另立一套视觉。
       */}
      <DropdownMenuSeparator />
      {recentlyClosed.length === 0 ? (
        <DropdownMenuItem disabled>
          <span className={labelClassName}>没有最近关闭的标签页</span>
        </DropdownMenuItem>
      ) : (
        recentlyClosed.map((tab, index) => (
          <DropdownMenuItem
            key={`${tab.url}#${String(index)}`}
            onClick={() => {
              onReopen(index)
            }}
          >
            <History aria-hidden className="size-3.5 shrink-0 opacity-50" />
            <span className={labelClassName}>{tab.title}</span>
            <ChevronRight aria-hidden className="size-3.5 shrink-0 opacity-50" />
          </DropdownMenuItem>
        ))
      )}
    </MenuShell>
  )
}
